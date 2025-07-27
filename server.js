const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs-extra");
const { v4: uuidv4 } = require("uuid");
const pdfParse = require("pdf-parse");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("uploads"));

// Configure multer for file uploads
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const uploadDir = "uploads";
		fs.ensureDirSync(uploadDir);
		cb(null, uploadDir);
	},
	filename: (req, file, cb) => {
		const uniqueName = `${uuidv4()}-${file.originalname}`;
		cb(null, uniqueName);
	},
});

const upload = multer({
	storage: storage,
	limits: {
		fileSize: 50 * 1024 * 1024, // 50MB limit
	},
	fileFilter: (req, file, cb) => {
		if (file.mimetype === "application/pdf") {
			cb(null, true);
		} else {
			cb(new Error("Only PDF files are allowed"), false);
		}
	},
});

// Initialize OpenAI
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY || "your-openai-api-key-here",
});

// In-memory storage for PDF data (in production, use a database)
const pdfStore = new Map();

// Routes

// Upload PDF
app.post("/api/upload-pdf", upload.single("pdf"), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ error: "No PDF file uploaded" });
		}

		console.log("File received:", req.file.originalname, "Size:", req.file.size);

		const filePath = req.file.path;
		const pdfId = path.basename(req.file.filename, path.extname(req.file.filename));

		console.log("Processing PDF:", pdfId);

		// Check if file exists
		if (!fs.existsSync(filePath)) {
			console.error("File not found at path:", filePath);
			return res.status(500).json({ error: "Uploaded file not found" });
		}

		// Read the file
		const dataBuffer = fs.readFileSync(filePath);
		console.log("PDF file read, size:", dataBuffer.length);

		if (dataBuffer.length === 0) {
			return res.status(500).json({ error: "PDF file is empty" });
		}

		// Try to parse PDF for text extraction, but don't fail if it doesn't work
		let text = "";
		let pages = 1;

		try {
			const pdfData = await pdfParse(dataBuffer);
			text = pdfData.text || "";
			pages = pdfData.numpages || 1;
			console.log("PDF parsed successfully, pages:", pages);

			if (!text || text.trim().length === 0) {
				console.warn("PDF contains no extractable text");
			}
		} catch (parseError) {
			console.warn("PDF parsing failed, but continuing with upload:", parseError.message);
			// Continue with upload even if parsing fails
			text = "Text extraction failed for this PDF. The file can still be viewed.";
			pages = 1;
		}

		// Store PDF data
		const pdfInfo = {
			id: pdfId,
			filename: req.file.originalname,
			filePath: filePath,
			text: text,
			pages: pages,
			uploadDate: new Date(),
			vectors: [], // In a real app, you'd vectorize the text here
		};

		pdfStore.set(pdfId, pdfInfo);
		console.log("PDF stored successfully:", pdfId);

		res.json({
			id: pdfId,
			filename: req.file.originalname,
			pages: pages,
			text: text,
			vectors: [],
			uploadDate: new Date(),
		});
	} catch (error) {
		console.error("PDF upload error:", error);
		console.error("Error stack:", error.stack);

		// Provide more specific error messages
		let errorMessage = "Failed to process PDF";
		if (error.message.includes("pdf-parse")) {
			errorMessage = "Failed to parse PDF file. The file might be corrupted or password protected.";
		} else if (error.message.includes("ENOENT")) {
			errorMessage = "File system error. Please try again.";
		} else if (error.message.includes("permission")) {
			errorMessage = "Permission denied. Please check file permissions.";
		}

		res.status(500).json({
			error: errorMessage,
			details: process.env.NODE_ENV === "development" ? error.message : undefined,
		});
	}
});

// Get PDF file
app.get("/api/pdf/:id/file", (req, res) => {
	try {
		const pdfId = req.params.id;
		const pdfInfo = pdfStore.get(pdfId);

		if (!pdfInfo) {
			return res.status(404).json({ error: "PDF not found" });
		}

		// Check if file exists
		if (!fs.existsSync(pdfInfo.filePath)) {
			return res.status(404).json({ error: "PDF file not found on disk" });
		}

		// Set headers for PDF download/viewing
		res.setHeader("Content-Type", "application/pdf");
		res.setHeader("Content-Disposition", `inline; filename="${pdfInfo.filename}"`);

		// Stream the file
		const fileStream = fs.createReadStream(pdfInfo.filePath);
		fileStream.pipe(res);
	} catch (error) {
		console.error("Error serving PDF file:", error);
		res.status(500).json({ error: "Failed to serve PDF file" });
	}
});

// Get PDF text
app.get("/api/pdf/:id/text", (req, res) => {
	try {
		const pdfId = req.params.id;
		const pdfInfo = pdfStore.get(pdfId);

		if (!pdfInfo) {
			return res.status(404).json({ error: "PDF not found" });
		}

		res.json(pdfInfo.text);
	} catch (error) {
		res.status(500).json({ error: "Failed to retrieve PDF text" });
	}
});

// Search PDF
app.post("/api/pdf/:id/search", async (req, res) => {
	try {
		const pdfId = req.params.id;
		const { query } = req.body;

		const pdfInfo = pdfStore.get(pdfId);
		if (!pdfInfo) {
			return res.status(404).json({ error: "PDF not found" });
		}

		// Simple text search (in production, use vector search)
		const searchResults = [];
		const lines = pdfInfo.text.split("\n");

		lines.forEach((line, index) => {
			if (line.toLowerCase().includes(query.toLowerCase())) {
				searchResults.push({
					line: line.trim(),
					lineNumber: index + 1,
					page: Math.floor(index / 50) + 1, // Rough page estimation
				});
			}
		});

		res.json(searchResults.slice(0, 10)); // Limit results
	} catch (error) {
		res.status(500).json({ error: "Search failed" });
	}
});

// Get page content
app.get("/api/pdf/:id/page/:pageNumber", (req, res) => {
	try {
		const pdfId = req.params.id;
		const pageNumber = parseInt(req.params.pageNumber);

		const pdfInfo = pdfStore.get(pdfId);
		if (!pdfInfo) {
			return res.status(404).json({ error: "PDF not found" });
		}

		// Simple page extraction (in production, use proper PDF page extraction)
		const lines = pdfInfo.text.split("\n");
		const linesPerPage = Math.ceil(lines.length / pdfInfo.pages);
		const startIndex = (pageNumber - 1) * linesPerPage;
		const endIndex = Math.min(startIndex + linesPerPage, lines.length);

		const pageContent = lines.slice(startIndex, endIndex).join("\n");

		res.json(pageContent);
	} catch (error) {
		res.status(500).json({ error: "Failed to get page content" });
	}
});

// Chat endpoint
app.post("/api/chat", async (req, res) => {
	try {
		const { message, pdfId } = req.body;

		let context = "";
		let citations = [];

		// If PDF ID is provided, get context from PDF
		if (pdfId) {
			const pdfInfo = pdfStore.get(pdfId);
			if (pdfInfo) {
				// Check if text extraction was successful
				if (pdfInfo.text && !pdfInfo.text.includes("Text extraction failed")) {
					// Simple context extraction (in production, use vector search)
					const lines = pdfInfo.text.split("\n");
					const relevantLines = lines.filter((line) => line.toLowerCase().includes(message.toLowerCase())).slice(0, 5);

					context = relevantLines.join("\n");

					// Generate citations
					relevantLines.forEach((line, index) => {
						citations.push({
							page: Math.floor(index / 50) + 1,
							text: line.trim(),
							confidence: 0.8,
						});
					});
				} else {
					// Text extraction failed, inform the user
					context =
						"I'm sorry, but I couldn't extract text from this PDF file. This might be because the PDF is password-protected, corrupted, or contains only images. You can still view the PDF, but I won't be able to answer questions about its content.";
				}
			}
		}

		// Prepare prompt for AI
		let prompt = `You are a helpful AI assistant. `;

		if (context) {
			if (context.includes("Text extraction failed")) {
				prompt += `The user is asking about a PDF document, but text extraction failed for this PDF. Please inform them that you cannot answer questions about the content of this specific PDF, but they can still view the document. User question: ${message}`;
			} else {
				prompt += `Based on the following context from a PDF document, please answer the user's question. If the information is not in the context, say so.\n\nContext:\n${context}\n\nUser question: ${message}`;
			}
		} else {
			prompt += `Please answer the following question: ${message}`;
		}

		// Call OpenAI API
		const completion = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [
				{
					role: "system",
					content:
						"You are a helpful AI assistant that answers questions about PDF documents. Provide concise, accurate answers and cite specific pages when referencing content from the PDF. If text extraction failed for a PDF, inform the user that you cannot answer questions about that specific document's content.",
				},
				{
					role: "user",
					content: prompt,
				},
			],
			max_tokens: 500,
			temperature: 0.7,
		});

		const aiResponse = completion.choices[0].message.content;

		res.json({
			message: aiResponse,
			citations: citations,
			tokenUsage: completion.usage.total_tokens,
		});
	} catch (error) {
		console.error("Chat error:", error);
		res.status(500).json({
			error: "Failed to process chat request",
			message: "Sorry, I encountered an error. Please try again.",
		});
	}
});

// Health check
app.get("/api/health", (req, res) => {
	res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
	console.error("Server error:", error);
	res.status(500).json({ error: "Internal server error" });
});

// Start server
app.listen(PORT, () => {
	console.log(`PDF Chat Backend running on port ${PORT}`);
	console.log(`Health check: http://localhost:${PORT}/api/health`);
});
