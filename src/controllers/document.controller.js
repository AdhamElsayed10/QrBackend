const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { generateQRCode, embedQRInPDF } = require('../services/pdf.service');
const { extractContractDataFromPDF } = require('../services/extractor.service');

const prisma = new PrismaClient();

// Placement settings: Bottom right on first page only
const FUJAIRAH_QR_SETTINGS = {
  position: 'custom',
  customX: 464,
  customY: 175,
  qrSize: 65,
  pageSelection: 'first',
};

const GENERIC_QR_SETTINGS = {
  position: 'bottom-right',
  qrSize: 65,
  pageSelection: 'first',
};

/**
 * Determine public base URL safely without ever leaking localhost into generated QR codes or PDFs
 */
function getPublicBaseUrl(req) {
  // 1. Explicit production URL from environment if configured and NOT localhost
  const envUrl = (process.env.PUBLIC_APP_URL || '').trim();
  if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
    return envUrl.replace(/\/+$/, '');
  }

  // 2. Check X-Forwarded-Host from Vercel / Railway / reverse proxy
  const forwardedHost = req?.headers?.['x-forwarded-host'];
  const forwardedProto = req?.headers?.['x-forwarded-proto'] || 'https';
  if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
    const host = forwardedHost.split(',')[0].trim();
    return `${forwardedProto}://${host}`;
  }

  // 3. Check Origin header (e.g. if uploaded from Vercel frontend)
  const origin = req?.headers?.['origin'];
  if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    return origin.replace(/\/+$/, '');
  }

  // 4. Check standard Host header if NOT localhost (e.g. direct Railway backend domain)
  const host = req?.headers?.['host'];
  if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
    const proto = req?.secure || req?.headers?.['x-forwarded-proto'] === 'https' ? 'https' : 'https';
    return `${proto}://${host}`;
  }

  
  // 5. Safe production fallback (used in local dev or fallback so QR codes NEVER have localhost)
  return (process.env.DEFAULT_PRODUCTION_URL || 'https://ejaar.fujmen.com').replace(/\/+$/, '');
}

exports.uploadDocuments = async (req, res) => {
  const files = req.files || [];

  console.log('[Upload Controller] Files received:', files.map(f => ({
    fieldname: f.fieldname,
    originalname: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
    path: f.path,
  })));

  if (files.length === 0) {
    return res.status(400).json({ error: 'At least one PDF file is required.' });
  }

  const baseUrl = getPublicBaseUrl(req);
  console.log('[Upload Controller] Resolved public QR baseUrl:', baseUrl);
  const results = [];

  for (const file of files) {
    const token = uuidv4();
    const qrUrl = `${baseUrl}/pdf/${token}`;
    // Decode originalname from latin1 to UTF-8 (multer encodes non-ASCII filenames as latin1)
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const title = path.basename(decodedName, '.pdf').replace(/_/g, ' ');

    // 1. Extract contract data from uploaded PDF
    let extractionResult = { isDataFilled: false, isFujairahContract: false, contractData: null };
    try {
      extractionResult = await extractContractDataFromPDF(file.path);
    } catch (e) {
      console.warn(`[Extractor] Warning: could not extract data from ${title}:`, e.message);
    }

    const { isDataFilled, isFujairahContract, contractData } = extractionResult;

    // Create document record with PROCESSING status
    const doc = await prisma.document.create({
      data: {
        title,
        originalFilePath: file.path,
        qrToken: token,
        qrUrl,
        processingStatus: 'PROCESSING',
        isDataFilled: Boolean(isDataFilled),
        contractData: contractData ? JSON.stringify(contractData) : null,
      },
    });

    try {
      // Generate QR code image pointing to the public contract page
      const qrImagePath = await generateQRCode(qrUrl, token);

      // Select QR placement: bottom-right on first page only
      let qrPlacement = extractionResult.qrPlacement;
      if (!qrPlacement && isFujairahContract) {
        try {
          const { PDFDocument } = require('pdf-lib');
          const pdfDoc = await PDFDocument.load(fs.readFileSync(file.path));
          const { width, height } = pdfDoc.getPage(0).getSize();
          if (Math.abs(width - 595.32) < 20 && Math.abs(height - 841.92) < 20) {
            qrPlacement = { position: 'custom', customX: 476, customY: 201.5, qrSize: 65, pageSelection: 'first' };
          } else {
            qrPlacement = FUJAIRAH_QR_SETTINGS;
          }
        } catch (_) {
          qrPlacement = FUJAIRAH_QR_SETTINGS;
        }
      }
      if (!qrPlacement) {
        qrPlacement = GENERIC_QR_SETTINGS;
      }

      // Embed QR in PDF on first page only
      const processedPath = await embedQRInPDF(file.path, qrImagePath, {
        ...qrPlacement,
        outputFilename: `processed_${token}.pdf`,
      });

      // Update document with COMPLETED status
      const updatedDoc = await prisma.document.update({
        where: { id: doc.id },
        data: {
          processedFilePath: processedPath,
          qrImagePath,
          processingStatus: 'COMPLETED',
        },
      });

      results.push({
        ...updatedDoc,
        contractData,
        isDataFilled: Boolean(isDataFilled),
      });
    } catch (err) {
      console.error(`Failed to process document ${doc.title}:`, err);

      await prisma.document.update({
        where: { id: doc.id },
        data: { processingStatus: 'FAILED' },
      }).catch(console.error);

      results.push({
        ...doc,
        processingStatus: 'FAILED',
        error: err.message,
        isDataFilled: Boolean(isDataFilled),
        contractData,
      });
    }
  }

  const allFailed = results.every(r => r.processingStatus === 'FAILED');
  if (allFailed) {
    return res.status(500).json({ error: 'All documents failed to process', documents: results });
  }

  res.status(201).json({ message: 'Documents uploaded successfully', documents: results });
};

exports.getDocuments = async (req, res) => {
  try {
    const { search = '', page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = search
      ? { title: { contains: search, mode: 'insensitive' } }
      : {};

    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.document.count({ where }),
    ]);

    res.json({
      documents: documents.map((d) => {
        let parsedData = null;
        try {
          if (d.contractData) parsedData = JSON.parse(d.contractData);
        } catch (_) {}

        return {
          id: d.id,
          title: d.title,
          qrToken: d.qrToken,
          qrUrl: d.qrUrl,
          processingStatus: d.processingStatus,
          isDataFilled: Boolean(d.isDataFilled),
          contractData: parsedData,
          createdAt: d.createdAt,
        };
      }),
      total,
    });
  } catch (err) {
    console.error('[Documents Controller] Error fetching:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
};

exports.getDocument = async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    let parsedData = null;
    try {
      if (doc.contractData) parsedData = JSON.parse(doc.contractData);
    } catch (_) {}

    res.json({
      id: doc.id,
      title: doc.title,
      qrToken: doc.qrToken,
      qrUrl: doc.qrUrl,
      processingStatus: doc.processingStatus,
      isDataFilled: Boolean(doc.isDataFilled),
      contractData: parsedData,
      createdAt: doc.createdAt,
    });
  } catch (err) {
    console.error('[Documents Controller] Error getting:', err);
    res.status(500).json({ error: 'Failed to get document' });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id },
    });

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filesToDelete = [
      doc.originalFilePath,
      doc.processedFilePath,
      doc.qrImagePath,
    ].filter(Boolean);

    for (const filePath of filesToDelete) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await prisma.document.delete({ where: { id: req.params.id } });

    res.json({ message: 'Document deleted successfully' });
  } catch (err) {
    console.error('[Documents Controller] Error deleting:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
};

exports.downloadDocument = async (req, res) => {
  try {
    const doc = await prisma.document.findUnique({
      where: { id: req.params.id },
    });

    if (!doc || !doc.processedFilePath) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!fs.existsSync(doc.processedFilePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const encodedTitle = encodeURIComponent(doc.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodedTitle}.pdf"; filename*=UTF-8''${encodedTitle}.pdf`);
    fs.createReadStream(doc.processedFilePath).pipe(res);
  } catch (err) {
    console.error('[Documents Controller] Error downloading:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
};