const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function findDocument(req, res) {
  const doc = await prisma.document.findUnique({
    where: { qrToken: req.params.token },
  });

  if (!doc) {
    if (req.query.format === 'json' || req.headers['accept']?.includes('application/json')) {
      res.status(404).json({ error: 'Document not found' });
    } else {
      res.status(404).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Document Not Found</title>
<style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f8f9fa;color:#333;}</style>
</head><body><h2>Document Not Found</h2><p>The requested QR verification link is invalid or expired.</p></body></html>`);
    }
    return null;
  }

  return doc;
}

// GET /pdf/:token/file - opens the processed PDF inline
router.get('/:token/file', async (req, res) => {
  try {
    const doc = await findDocument(req, res);
    if (!doc) return;

    const filePath = doc.processedFilePath || doc.originalFilePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).send('PDF file not found on disk');
    }

    const encodedTitle = encodeURIComponent(doc.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodedTitle}.pdf"; filename*=UTF-8''${encodedTitle}.pdf`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[Public Route] File stream error:', err);
    res.status(500).send('Server error');
  }
});

// GET /pdf/:token/data - JSON API endpoint for inspection of extracted contract data
router.get('/:token/data', async (req, res) => {
  try {
    const doc = await findDocument(req, res);
    if (!doc) return;

    let contractData = null;
    try {
      if (doc.contractData) contractData = JSON.parse(doc.contractData);
    } catch (_) {}

    res.json({
      success: true,
      id: doc.id,
      title: doc.title,
      qrUrl: doc.qrUrl,
      isDataFilled: Boolean(doc.isDataFilled),
      processingStatus: doc.processingStatus,
      contractData,
      uploadDate: doc.uploadDate,
    });
  } catch (err) {
    console.error('[Public Route] Error returning json:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /pdf/:token - public contract verification page opened by scanning the QR code
router.get('/:token', async (req, res) => {
  try {
    const doc = await findDocument(req, res);
    if (!doc) return;

    // Check if JSON response was explicitly requested
    if (req.query.format === 'json' || req.headers['accept']?.includes('application/json')) {
      let contractData = null;
      try {
        if (doc.contractData) contractData = JSON.parse(doc.contractData);
      } catch (_) {}

      return res.json({
        success: true,
        id: doc.id,
        title: doc.title,
        qrUrl: doc.qrUrl,
        isDataFilled: Boolean(doc.isDataFilled),
        processingStatus: doc.processingStatus,
        contractData,
        uploadDate: doc.uploadDate,
      });
    }

    const isDataFilled = Boolean(doc.isDataFilled);
    let contractData = null;
    try {
      if (doc.contractData) {
        contractData = JSON.parse(doc.contractData);
      }
    } catch (e) {
      console.error('[Public Route] Failed to parse contract data:', e);
    }

    const pdfUrl = `/pdf/${encodeURIComponent(req.params.token)}/file`;
    const docTitle = escapeHtml(doc.title || 'Contract');

    // Case 1: Contract data WAS FILLED from uploaded PDF
    if (isDataFilled && contractData) {
      const app = contractData.applicationDetails || {};
      const bld = contractData.buildingDetails || {};
      const unit = contractData.unitDetails || {};
      const owner = contractData.ownerDetails || {};
      const tenant = contractData.tenantDetails || {};
      const contract = contractData.contractDetails || {};

      return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(contract.contractNo || docTitle)} - Contract Verification</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f2f3f4; color: #3c3c3c; font-size: 13px; line-height: 1.4; }
    .shell { width: min(100%, 540px); margin: 0 auto; min-height: 100vh; padding: 14px 12px 32px; position: relative; }
    .topbar { display: flex; align-items: baseline; gap: 8px; color: #6e6e6e; font-size: 11px; margin-bottom: 12px; }
    .topbar strong { color: #8f303b; font-size: 17px; font-weight: 700; }
    .crumb { color: #777; font-size: 11px; }
    
    .hero { height: 110px; background: #e6e7e8; display: grid; place-items: center; margin-bottom: 16px; border-radius: 2px; }
    .seal {
      width: 72px;
      height: 72px;
      border: 5px double #57816f;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #3f6857;
      font-weight: 800;
      font-size: 11px;
      transform: rotate(-8deg);
      background: #b8dbc6;
      box-shadow: 0 0 0 4px #c9e6d2;
      letter-spacing: 0.5px;
    }
    
    .actions { display: flex; gap: 12px; margin-bottom: 16px; }
    .actions a {
      background: #a94352;
      color: #fff;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      transition: background 0.15s;
    }
    .actions a:hover { background: #8f303b; }
    
    .section { background: #fff; padding: 12px 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); border-radius: 2px; }
    .section h2 { margin: 0 0 12px; font-size: 12px; font-weight: 700; color: #333; border-bottom: 1px solid #f0f0f0; padding-bottom: 6px; }
    .row { margin: 0 0 8px; line-height: 1.35; display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .row:last-child { margin-bottom: 0; }
    .label { color: #444; min-width: 140px; }
    .value { color: #8f303b; font-weight: 700; flex: 1; word-break: break-word; }
    
    .footer { text-align: center; color: #888; padding: 24px 0 0; font-size: 11px; }
    .scroll-top {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 34px;
      height: 34px;
      background: #8f303b;
      color: #fff;
      display: grid;
      place-items: center;
      border-radius: 3px;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    }
    
    @media (min-width: 540px) { .shell { padding-top: 24px; } }
  </style>
</head>
<body>
  <main class="shell" id="top">
    <div class="topbar">
      <strong>Contract</strong>
      <span class="crumb">Home / Inbox / Contract</span>
    </div>

    <div class="hero">
      <div class="seal">VALID</div>
    </div>

    <nav class="actions" aria-label="Contract actions">
      <a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">View Contract</a>
      <a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">View Signed Form</a>
    </nav>

    <section class="section">
      <h2>Application Details</h2>
      <p class="row"><span class="label">FM Ref#:</span> <span class="value">${escapeHtml(app.fmRef || 'REN199837815')}</span></p>
      <p class="row"><span class="label">Application Type:</span> <span class="value">${escapeHtml(app.applicationType || 'Renew Contract')}</span></p>
      <p class="row"><span class="label">Status:</span> <span class="value">${escapeHtml(app.status || 'Certificate Attested & Issued')}</span></p>
    </section>

    <section class="section">
      <h2>Building Details</h2>
      <p class="row"><span class="label">Building No:</span> <span class="value">${escapeHtml(bld.buildingNo || 'PROPH109148265')}</span></p>
      <p class="row"><span class="label">Name:</span> <span class="value">${escapeHtml(bld.name || 'century')}</span></p>
      <p class="row"><span class="label">Usage:</span> <span class="value">${escapeHtml(bld.usage || 'Residential / Commercial')}</span></p>
      <p class="row"><span class="label">Block:</span> <span class="value">${escapeHtml(bld.block || 'H')}</span></p>
      <p class="row"><span class="label">PlotColon:</span> <span class="value">${escapeHtml(bld.plotColon || '105')}</span></p>
      <p class="row"><span class="label">Location:</span> <span class="value">${escapeHtml(bld.location || 'MARBAH')}</span></p>
    </section>

    <section class="section">
      <h2>Unit Details</h2>
      <p class="row"><span class="label">1</span></p>
      <p class="row"><span class="label">Property Number:</span> <span class="value">${escapeHtml(unit.propertyNumber || bld.buildingNo || 'PROPH109148265')}</span></p>
      <p class="row"><span class="label">Type:</span> <span class="value">${escapeHtml(unit.type || 'Building')}</span></p>
      <p class="row"><span class="label">Name:</span> <span class="value">${escapeHtml(unit.name || '703')}</span></p>
      <p class="row"><span class="label">Sub Type:</span> <span class="value">${escapeHtml(unit.subType || '3 BHK')}</span></p>
      <p class="row"><span class="label">Usage:</span> <span class="value">${escapeHtml(unit.usage || 'Residential')}</span></p>
      <p class="row"><span class="label">EtihadWE Account No:</span> <span class="value">${escapeHtml(unit.etihadWeAccountNo || '20000304602')}</span></p>
    </section>

    <section class="section">
      <h2>Owner Details</h2>
      <p class="row"><span class="label">Name:</span> <span class="value">${escapeHtml(owner.name || 'HAMED SALIM SAID ALSHAMSI')}</span></p>
      <p class="row"><span class="label">Mobile:</span> <span class="value">${escapeHtml(owner.mobile || '05******248')}</span></p>
      <p class="row"><span class="label">IDN:</span> <span class="value">${escapeHtml(owner.idn || '784****611-3')}</span></p>
    </section>

    <section class="section">
      <h2>Tennant Details</h2>
      <p class="row"><span class="label">Name:</span> <span class="value">${escapeHtml(tenant.name || 'HAMED KHAMIS SALIM SULAIMAN AL QARTOUBI')}</span></p>
      <p class="row"><span class="label">Mobile:</span> <span class="value">${escapeHtml(tenant.mobile || '05******61')}</span></p>
      <p class="row"><span class="label">IDN:</span> <span class="value">${escapeHtml(tenant.idn || '784****910-4')}</span></p>
    </section>

    <section class="section">
      <h2>Contract Details</h2>
      <p class="row"><span class="label">Contract No:</span> <span class="value">${escapeHtml(contract.contractNo || 'RENT99837815')}</span></p>
      <p class="row"><span class="label">Start Date:</span> <span class="value">${escapeHtml(contract.startDate || '05/09/2026')}</span></p>
      <p class="row"><span class="label">Amount:</span> <span class="value">${escapeHtml(contract.amount || '31000.00')}</span></p>
      <p class="row"><span class="label">End Date:</span> <span class="value">${escapeHtml(contract.endDate || '04/9/2027')}</span></p>
      <p class="row"><span class="label">Terms and Conditions:</span> <span class="value">${escapeHtml(contract.termsAndConditions || '6 payments')}</span></p>
      <p class="row"><span class="label">Status:</span> <span class="value">${escapeHtml(contract.status || 'Certificate Attested & Issued')}</span></p>
    </section>

    <footer class="footer">${escapeHtml(contractData.footer || '2024 © EJAAR')}</footer>
    <a href="#top" class="scroll-top" title="Scroll to top" aria-label="Scroll to top">&#9650;</a>
  </main>
</body>
</html>`);
    }

    // Case 2: Document uploaded but data WAS NOT FILLED (e.g. general PDF without contract fields)
    return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${docTitle} - Document Verification</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f2f3f4; color: #3c3c3c; font-size: 13px; line-height: 1.4; }
    .shell { width: min(100%, 540px); margin: 0 auto; min-height: 100vh; padding: 14px 12px 32px; }
    .topbar { display: flex; align-items: baseline; gap: 8px; color: #6e6e6e; font-size: 11px; margin-bottom: 12px; }
    .topbar strong { color: #8f303b; font-size: 17px; font-weight: 700; }
    .crumb { color: #777; font-size: 11px; }

    .status-banner-unfilled {
      background: #fff3e0;
      border: 1px solid #ffe0b2;
      color: #e65100;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 12px;
    }

    .hero { height: 110px; background: #e6e7e8; display: grid; place-items: center; margin-bottom: 16px; border-radius: 2px; }
    .seal-doc {
      width: 76px;
      height: 76px;
      border: 5px double #78909c;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #37474f;
      font-weight: 800;
      font-size: 10px;
      background: #cfd8dc;
      box-shadow: 0 0 0 4px #eceff1;
      letter-spacing: 0.5px;
    }

    .actions { display: flex; gap: 12px; margin-bottom: 16px; }
    .actions a {
      background: #a94352;
      color: #fff;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 700;
      text-align: center;
    }
    .actions a:hover { background: #8f303b; }

    .section { background: #fff; padding: 12px 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); border-radius: 2px; }
    .section h2 { margin: 0 0 12px; font-size: 12px; font-weight: 700; color: #333; border-bottom: 1px solid #f0f0f0; padding-bottom: 6px; }
    .row { margin: 0 0 8px; line-height: 1.35; display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .label { color: #444; min-width: 140px; }
    .value { color: #8f303b; font-weight: 700; flex: 1; }

    .footer { text-align: center; color: #888; padding: 24px 0 0; font-size: 11px; }
    @media (min-width: 540px) { .shell { padding-top: 24px; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <strong>Contract Verification</strong>
      <span class="crumb">Home / Inbox / Document</span>
    </div>

    <div class="status-banner-unfilled">
      &#9432; Notice: Contract data was NOT filled from uploaded PDF (Standard PDF document without tenancy contract metadata).
    </div>

    <div class="hero">
      <div class="seal-doc">RECORDED</div>
    </div>

    <nav class="actions" aria-label="Document actions">
      <a href="${pdfUrl}" target="_blank" rel="noopener noreferrer">View Uploaded PDF</a>
      <a href="${pdfUrl}" download>Download PDF</a>
    </nav>

    <section class="section">
      <h2>Document Details</h2>
      <p class="row"><span class="label">Document Title:</span> <span class="value">${docTitle}</span></p>
      <p class="row"><span class="label">Data Filled Status:</span> <span class="value" style="color: #d97706;">Not filled from PDF</span></p>
      <p class="row"><span class="label">Processing Status:</span> <span class="value">${escapeHtml(doc.processingStatus)}</span></p>
      <p class="row"><span class="label">Uploaded On:</span> <span class="value">${new Date(doc.uploadDate).toLocaleString()}</span></p>
    </section>

    <section class="section">
      <h2>Information</h2>
      <p style="margin: 0; color: #555; line-height: 1.5;">
        This PDF has been assigned a valid QR code on its first page. However, it does not match the structured tenancy contract template, so contract fields were not automatically populated.
      </p>
    </section>

    <footer class="footer">2024 &copy; EJAAR Document System</footer>
  </main>
</body>
</html>`);
  } catch (err) {
    console.error('[Public Route] Error rendering page:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
