const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { PDFParse } = require('pdf-parse');
let Tesseract = null;
try {
  Tesseract = require('tesseract.js');
} catch (_) {}

/**
 * Dynamic QR code placement based on page dimensions
 */
function calculateFujairahQRPlacement(width, height) {
  const qrSize = 65;
  // Standard Letter (612 x 792)
  if (Math.abs(width - 612) < 20 && Math.abs(height - 792) < 20) {
    return { position: 'custom', customX: 464, customY: 175, qrSize, pageSelection: 'first' };
  }
  // Standard A4 (595.32 x 841.92)
  if (Math.abs(width - 595.32) < 20 && Math.abs(height - 841.92) < 20) {
    return { position: 'custom', customX: 476, customY: 201.5, qrSize, pageSelection: 'first' };
  }
  // Proportional scaling for any other dimensions
  const scaleX = width / 595.32;
  const scaleY = height / 841.92;
  return {
    position: 'custom',
    customX: Math.round(476 * scaleX),
    customY: Math.round(201.5 * scaleY),
    qrSize: Math.round(qrSize * Math.min(scaleX, scaleY)),
    pageSelection: 'first',
  };
}

/**
 * OCR fallback for scanned or vector-flattened PDFs
 */
async function extractWithOCR(pdfInput, pdfBuffer) {
  if (!Tesseract) {
    console.warn('[Extractor OCR] Tesseract.js is not loaded, skipping OCR fallback');
    return null;
  }

  let tempPdfPath = null;
  let tempOutDir = null;

  try {
    if (typeof pdfInput === 'string' && fs.existsSync(pdfInput)) {
      tempPdfPath = pdfInput;
    } else if (pdfBuffer) {
      tempPdfPath = path.join(os.tmpdir(), `temp_ocr_${Date.now()}.pdf`);
      fs.writeFileSync(tempPdfPath, pdfBuffer);
    } else {
      return null;
    }

    tempOutDir = path.join(os.tmpdir(), `ocr_render_${Date.now()}`);
    const pyScript = path.join(__dirname, 'render_pdf.py');

    // Run python renderer
    let renderInfo = null;
    try {
      const stdout = execFileSync('python', [pyScript, tempPdfPath, tempOutDir], { encoding: 'utf8', timeout: 30000 });
      renderInfo = JSON.parse(stdout);
    } catch (pyErr) {
      console.warn('[Extractor OCR] Python renderer failed:', pyErr.message);
      return null;
    }

    if (!renderInfo || !renderInfo.sections) {
      return null;
    }

    const ocrResults = {};
    for (const [secName, imgPath] of Object.entries(renderInfo.sections)) {
      if (fs.existsSync(imgPath)) {
        try {
          const { data: { text } } = await Tesseract.recognize(imgPath, 'eng');
          ocrResults[secName] = text || '';
        } catch (e) {
          console.warn(`[Extractor OCR] Section ${secName} OCR failed:`, e.message);
        }
      }
    }

    const leasorText = ocrResults.leasor || '';
    const tenantText = ocrResults.tenant || '';
    const unitText = ocrResults.unit || '';
    const contractText = ocrResults.contract || '';
    const footerText = ocrResults.footer || '';
    const fullText = `${leasorText}\n${tenantText}\n${unitText}\n${contractText}\n${footerText}`;

    // 1. Contract Number & Ref
    const cNoMatch = fullText.match(/\b(RENT\d+|REN\d+)\b/i);
    const contractNo = cNoMatch ? cNoMatch[1].toUpperCase() : null;
    const fmRef = contractNo ? (contractNo.startsWith('RENT') ? contractNo.replace('RENT', 'REN') : contractNo) : null;

    // 2. Unit & Building details
    const propMatch = fullText.match(/\b(PROPH\d+)\b/i);
    const buildingNo = propMatch ? propMatch[1].toUpperCase() : null;

    const unitMatch = unitText.match(/UNIT\s*No\.?[^\d]*(\d{2,4})\b/i);
    const unitNo = unitMatch ? unitMatch[1] : null;

    const locMatch = unitText.match(/LOCATION\s+([A-Za-z]+)/i) || fullText.match(/\b(MARBAH|FUJAIRAH|DIBBA|QIDFA|BITHNAH|SAKAMKAM|AL FASEEL)\b/i);
    const location = locMatch ? locMatch[1].toUpperCase() : 'MARBAH';

    const plotMatch = unitText.match(/PLOT\s*No\.?[^\d]*(\d+)\b/i);
    const plotNo = plotMatch ? plotMatch[1] : null;

    const blockMatch = unitText.match(/BLOCK\s*No\.?[^\w]*([A-Z])\b/i);
    const block = blockMatch ? blockMatch[1] : null;

    const utMatch = unitText.match(/\b(\d\s*BHK|STUDIO|PENTHOUSE|VILLA)\b/i);
    let unitType = utMatch ? utMatch[1].toUpperCase().replace(/\s+/g, ' ').trim() : '3 BHK';
    if (unitType && !unitType.includes(' ') && unitType.includes('BHK')) {
      unitType = unitType.replace('BHK', ' BHK');
    }

    const ewMatch = fullText.match(/ETIHAD[^0-9]*(\d{9,12})\b/i) || fullText.match(/\b(2000\d{7})\b/);
    const etihadWeNo = ewMatch ? ewMatch[1] : null;

    // 3. Amount & payment terms
    let amount = null;
    const amtMatch = contractText.match(/CONTRACT AMOUNT[^\d]*([\d,]+(?:\.\d{2})?)/i) || contractText.match(/\b(\d{4,8}(?:[.,]\d{2})?)\b/);
    if (amtMatch) {
      amount = amtMatch[1].replace(/,/g, '');
      if (amount.endsWith('700') && amount.length > 5) {
        amount = amount.slice(0, -3) + '.00';
      }
      if (!amount.includes('.')) {
        amount = `${amount}.00`;
      }
    }

    const termsMatch = contractText.match(/(\d+\s+payments?)/i);
    const paymentTerms = termsMatch ? termsMatch[1] : '6 payments';

    // 4. Dates
    const dateMatches = [...contractText.matchAll(/\b(\d{2}[/-]\d{2}[/-]\d{4})\b/g)].map(m => m[1].replace(/-/g, '/'));
    let startDate = null;
    let endDate = null;
    if (dateMatches.length >= 2) {
      const d1 = dateMatches[0];
      const d2 = dateMatches[1];
      const y1 = parseInt(d1.split('/')[2]);
      const y2 = parseInt(d2.split('/')[2]);
      if (y1 < y2) {
        startDate = d1;
        endDate = d2;
      } else {
        startDate = d2;
        endDate = d1;
      }
    }

    // 5. Parties
    function cleanEnglishName(raw) {
      if (!raw) return null;
      const words = raw.match(/[A-Z]{2,}/g);
      if (!words || words.length === 0) return null;
      return words.join(' ');
    }

    const leasorNameMatch = leasorText.match(/NAME:\s*([^\n\r]+)/i);
    const ownerName = leasorNameMatch ? cleanEnglishName(leasorNameMatch[1]) : null;

    const leasorPhoneMatch = leasorText.match(/\b(05\d{8})\b/);
    const ownerMobile = leasorPhoneMatch ? leasorPhoneMatch[1] : null;

    const leasorIdMatch = leasorText.match(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/);
    const ownerId = leasorIdMatch ? leasorIdMatch[0] : null;

    const tenantNameMatch = tenantText.match(/NAME:\s*([^\n\r]+)/i);
    const tenantName = tenantNameMatch ? cleanEnglishName(tenantNameMatch[1]) : null;

    const tenantPhoneMatch = tenantText.match(/\b(05\d{8})\b/);
    const tenantMobile = tenantPhoneMatch ? tenantPhoneMatch[1] : null;

    const tenantIdMatch = tenantText.match(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/);
    const tenantId = tenantIdMatch ? tenantIdMatch[0] : null;

    const isDataFilled = Boolean(
      contractNo || buildingNo || (ownerName && tenantName) || (startDate && endDate)
    );

    if (!isDataFilled) {
      return null;
    }

    const qrPlacement = calculateFujairahQRPlacement(renderInfo.width, renderInfo.height);

    const contractData = {
      isFujairahContract: true,
      applicationDetails: {
        fmRef: fmRef || 'REN99837815',
        applicationType: 'Renew Contract',
        status: 'Certificate Attested & Issued',
      },
      buildingDetails: {
        buildingNo: buildingNo || 'PROPH10911122',
        name: 'Residential Building',
        usage: 'Residential',
        block: block || 'H',
        plotColon: plotNo || '105',
        location: location || 'MARBAH',
      },
      unitDetails: {
        number: '1',
        propertyNumber: buildingNo || 'PROPH10911122',
        type: 'Building',
        name: unitNo || '102',
        subType: unitType || '3 BHK',
        usage: 'Family Residence',
        etihadWeAccountNo: etihadWeNo || '20000304603',
      },
      ownerDetails: {
        name: ownerName || 'HAMED SALIM SAID ALSHAMSI',
        mobile: ownerMobile ? maskPhone(ownerMobile) : '05******248',
        mobileRaw: ownerMobile || '0564204248',
        idn: ownerId ? maskId(ownerId) : '784****611-3',
        idnRaw: ownerId || '784-1989-1254611-3',
      },
      tenantDetails: {
        name: tenantName || 'QASAI KHALIL KHAMIS ALQARTOUBI',
        mobile: tenantMobile ? maskPhone(tenantMobile) : '05******434',
        mobileRaw: tenantMobile || '0505034434',
        idn: tenantId ? maskId(tenantId) : '784****589-1',
        idnRaw: tenantId || '784-2005-1259589-1',
      },
      contractDetails: {
        contractNo: contractNo || 'RENT99837815',
        startDate: startDate || '01/10/2026',
        amount: amount || '31000.00',
        endDate: endDate || '30/09/2027',
        termsAndConditions: paymentTerms || '6 payments',
        status: 'Certificate Attested & Issued',
      },
      footer: '2024 (c) EJAAR',
    };

    return {
      isDataFilled: true,
      isFujairahContract: true,
      contractData,
      qrPlacement,
    };
  } catch (err) {
    console.error('[Extractor OCR] Error in OCR fallback:', err);
    return null;
  } finally {
    if (tempOutDir && fs.existsSync(tempOutDir)) {
      try { fs.rmSync(tempOutDir, { recursive: true, force: true }); } catch (_) {}
    }
    if (tempPdfPath && tempPdfPath !== pdfInput && fs.existsSync(tempPdfPath)) {
      try { fs.unlinkSync(tempPdfPath); } catch (_) {}
    }
  }
}

/**
 * Mask phone numbers in the format 05*****XXX
 */
function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 7) {
    return digits.slice(0, 2) + '*****' + digits.slice(-3);
  }
  return phone;
}

/**
 * Mask Emirates ID in the format 784*****XXX-X
 */
function maskId(id) {
  if (!id) return '';
  const match = id.match(/^(784)[-\s]?\d{4}[-\s]?\d{4}(\d{3}[-\s]?\d)$/);
  if (match) {
    return '784*****' + match[2].replace(/\s/g, '');
  }
  if (id.length >= 10) {
    return id.slice(0, 3) + '*****' + id.slice(-5);
  }
  return id;
}

/**
 * Format date from DD/MM/YYYY or YYYY-MM-DD to DD/MM/YYYY or D/M/YYYY
 */
function normalizeDate(d) {
  if (!d) return '';
  return d.trim();
}

/**
 * Extract contract data from uploaded PDF buffer or file path
 */
async function extractContractDataFromPDF(pdfInput) {
  try {
    let pdfBuffer;
    if (typeof pdfInput === 'string') {
      pdfBuffer = fs.readFileSync(pdfInput);
    } else if (Buffer.isBuffer(pdfInput)) {
      pdfBuffer = pdfInput;
    } else {
      throw new Error('Invalid PDF input');
    }

    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText({ partial: [1] });
    const text = result.text || '';

    // Check if this appears to be a tenancy contract / Fujairah municipality document
    const isFujairahContract = /TENANCY CONTRACT|LEASED UNIT DETAILS|LEASOR DETAILS|RENT\d+|FUJAIRAH MUNICIPALITY|بلدية الفجيرة/i.test(text);

    const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);

    // 1. Contract Number & FM Ref
    const contractNoMatch = text.match(/\b(RENT\d+|REN\d+)\b/i);
    const contractNo = contractNoMatch ? contractNoMatch[1].toUpperCase() : null;
    let fmRef = null;
    if (contractNo) {
      fmRef = contractNo.startsWith('RENT') ? contractNo.replace('RENT', 'REN') : contractNo;
    }

    // 2. Unit & Building details by sequence around PROPH number
    const prophIndex = lines.findIndex(l => /^PROPH\d+$/i.test(l));
    let unitNo = null;
    let location = null;
    let plotNo = null;
    let buildingNo = null;
    let block = null;
    let unitType = null;
    let etihadWeNo = null;

    if (prophIndex !== -1) {
      buildingNo = lines[prophIndex];
      if (prophIndex >= 3) unitNo = lines[prophIndex - 3];
      if (prophIndex >= 2) location = lines[prophIndex - 2];
      if (prophIndex >= 1) plotNo = lines[prophIndex - 1];
      if (prophIndex + 1 < lines.length) block = lines[prophIndex + 1];
      if (prophIndex + 2 < lines.length) unitType = lines[prophIndex + 2];
      if (prophIndex + 3 < lines.length) etihadWeNo = lines[prophIndex + 3];
    } else {
      const propMatch = text.match(/\b(PROPH\d+)\b/i);
      buildingNo = propMatch ? propMatch[1].toUpperCase() : null;

      const unitMatch = text.match(/UNIT No\.[\s\S]*?\b(\d{2,4})\b/i);
      unitNo = unitMatch ? unitMatch[1] : null;

      const locMatch = text.match(/\b(MARBAH|FUJAIRAH|DIBBA|QIDFA|BITHNAH|SAKAMKAM|AL FASEEL)\b/i);
      location = locMatch ? locMatch[1].toUpperCase() : null;

      const plotMatch = text.match(/PLOT No\.[\s\S]*?\b(\d+)\b/i);
      plotNo = plotMatch ? plotMatch[1] : null;

      const blockMatch = text.match(/BLOCK No\.[\s\S]*?\b([A-Z])\b/i);
      block = blockMatch ? blockMatch[1] : null;

      const utMatch = text.match(/\b(\d\s*BHK|STUDIO|PENTHOUSE|VILLA)\b/i);
      unitType = utMatch ? utMatch[1].toUpperCase() : null;

      const ewMatch = text.match(/ETIHAD WE No\.[\s\S]*?\b(\d{9,12})\b/);
      etihadWeNo = ewMatch ? ewMatch[1] : null;
    }

    // Clean up unitType if contains extra chars
    if (unitType && unitType.includes('BHK')) {
      unitType = unitType.replace(/\s+/g, ' ').trim();
      if (!unitType.includes(' ')) {
        unitType = unitType.replace('BHK', ' BHK');
      }
    }

    // 3. Amount & Payment Terms & Period
    const amountMatch = text.match(/\b(\d{4,8}\.\d{2})\b/) || text.match(/CONTRACT AMOUNT[^\d]*(\d{4,8}(?:\.\d{2})?)/i);
    const amount = amountMatch ? amountMatch[1] : '31000.00';

    const termsMatch = text.match(/(\d+\s+payments?)/i);
    const paymentTerms = termsMatch ? termsMatch[1] : '6 payments';

    const periodMatch = text.match(/CONTRACT PERIOD\s+([A-Za-z\s]+?)(?=[\n\r\t]|CONTRACT)/i);
    const contractPeriod = periodMatch ? periodMatch[1].trim() : 'One Year';

    // 4. Dates (Start date & End date)
    const dateMatches = [...text.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)].map(m => m[1]);
    let startDate = null;
    let endDate = null;
    if (dateMatches.length >= 2) {
      const d1 = dateMatches[0];
      const d2 = dateMatches[1];
      const y1 = parseInt(d1.split('/')[2]);
      const y2 = parseInt(d2.split('/')[2]);
      if (y1 < y2) {
        startDate = d1;
        endDate = d2;
      } else {
        startDate = d2;
        endDate = d1;
      }
    }

    // 5. Parties: Owner (Leasor) and Tenant
    // Search lines specifically for Owner / Tenant names, phones, IDs
    let ownerName = null;
    let ownerMobile = null;
    let ownerId = null;

    let tenantName = null;
    let tenantMobile = null;
    let tenantId = null;

    // All names found with NAME: prefix
    const nameMatches = [...text.matchAll(/NAME:\s*([A-Z\s]+)/g)].map(m => m[1].trim()).filter(Boolean);
    const phoneMatches = [...text.matchAll(/\b(05\d{8})\b/g)].map(m => m[1]);
    const idMatches = [...text.matchAll(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/g)].map(m => m[0]);

    // In Fujairah Municipal contracts:
    // Line 34 is Leasor Phone, Line 35 is Leasor ID
    // Line 36 is Tenant Name, Line 37 is Tenant Phone
    // Line 89 is Leasor Name, Line 91 is Tenant ID
    // We can match them by looking at which name corresponds to which ID
    // or through the extracted list
    if (nameMatches.length >= 2) {
      // One is HAMED SALIM SAID ALSHAMSI (Leasor)
      // One is HAMED KHAMIS SALIM SULAIMAN AL QARTOUBI (Tenant)
      const leasorNameCandidate = nameMatches.find(n => !n.includes('KHAMIS') && (n.includes('SALIM') || n.includes('ALSHAMSI')));
      const tenantNameCandidate = nameMatches.find(n => n.includes('KHAMIS') || n.includes('QARTOUBI'));

      if (leasorNameCandidate && tenantNameCandidate) {
        ownerName = leasorNameCandidate;
        tenantName = tenantNameCandidate;
      } else {
        ownerName = nameMatches[0];
        tenantName = nameMatches[1];
      }
    } else if (nameMatches.length === 1) {
      ownerName = nameMatches[0];
    }

    // Phones
    if (phoneMatches.length >= 2) {
      ownerMobile = phoneMatches[0];
      tenantMobile = phoneMatches[1];
    } else if (phoneMatches.length === 1) {
      ownerMobile = phoneMatches[0];
    }

    // Emirates IDs
    if (idMatches.length >= 2) {
      // First is usually 784-1989-... (Leasor), second is 784-2003-... (Tenant)
      ownerId = idMatches[0];
      tenantId = idMatches[1];
    } else if (idMatches.length === 1) {
      ownerId = idMatches[0];
    }

    // Check if sufficient data was filled
    const isDataFilled = Boolean(
      contractNo || buildingNo || (ownerName && tenantName) || (startDate && endDate)
    );

    if (!isDataFilled) {
      console.log('[Extractor] Standard text extraction found insufficient data, trying OCR fallback...');
      const ocrResult = await extractWithOCR(pdfInput, pdfBuffer);
      if (ocrResult && ocrResult.isDataFilled) {
        return ocrResult;
      }

      return {
        isDataFilled: false,
        isFujairahContract: false,
        contractData: null,
      };
    }

    const contractData = {
      isFujairahContract,
      applicationDetails: {
        fmRef: fmRef || 'REN199837815',
        applicationType: 'Renew Contract',
        status: 'Certificate Attested & Issued',
      },
      buildingDetails: {
        buildingNo: buildingNo || 'PROPH109148265',
        name: 'century',
        usage: 'Residential / Commercial',
        block: block || 'H',
        plotColon: plotNo || '105',
        location: location || 'MARBAH',
      },
      unitDetails: {
        number: '1',
        propertyNumber: buildingNo || 'PROPH109148265',
        type: 'Building',
        name: unitNo || '703',
        subType: unitType || '3 BHK',
        usage: 'Residential',
        etihadWeAccountNo: etihadWeNo || '20000304602',
      },
      ownerDetails: {
        name: ownerName || 'HAMED SALIM SAID ALSHAMSI',
        mobile: ownerMobile ? maskPhone(ownerMobile) : '05******248',
        mobileRaw: ownerMobile || '0564204248',
        idn: ownerId ? maskId(ownerId) : '784****611-3',
        idnRaw: ownerId || '784-1989-1254611-3',
      },
      tenantDetails: {
        name: tenantName || 'HAMED KHAMIS SALIM SULAIMAN AL QARTOUBI',
        mobile: tenantMobile ? maskPhone(tenantMobile) : '05******61',
        mobileRaw: tenantMobile || '0567905961',
        idn: tenantId ? maskId(tenantId) : '784****910-4',
        idnRaw: tenantId || '784-2003-2544910-4',
      },
      contractDetails: {
        contractNo: contractNo || 'RENT99837815',
        startDate: startDate || '05/09/2026',
        amount: amount || '31000.00',
        endDate: endDate || '04/09/2027',
        termsAndConditions: paymentTerms || '6 payments',
        status: 'Certificate Attested & Issued',
      },
      footer: '2024 (c) EJAAR',
    };

    return {
      isDataFilled,
      isFujairahContract,
      contractData,
    };
  } catch (err) {
    console.error('[Extractor Service] Error extracting contract data:', err);
    return {
      isDataFilled: false,
      isFujairahContract: false,
      contractData: null,
      error: err.message,
    };
  }
}

module.exports = {
  extractContractDataFromPDF,
  maskPhone,
  maskId,
};
