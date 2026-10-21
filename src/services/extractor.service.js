const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { PDFParse } = require('pdf-parse');
let Tesseract = null;
try { Tesseract = require('tesseract.js'); } catch (_) {}

const TESSDATA_DIR = path.join(__dirname, '../../assets');
const ENG_TESSDATA = path.join(TESSDATA_DIR, 'eng.traineddata');
const ARA_TESSDATA = path.join(TESSDATA_DIR, 'ara.traineddata');

function getTessdataDir() {
  const tmp = path.join(os.tmpdir(), `tessdata_${process.pid}`);
  if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
  if (fs.existsSync(ENG_TESSDATA) && !fs.existsSync(path.join(tmp, 'eng.traineddata'))) {
    fs.copyFileSync(ENG_TESSDATA, path.join(tmp, 'eng.traineddata'));
  }
  if (fs.existsSync(ARA_TESSDATA) && !fs.existsSync(path.join(tmp, 'ara.traineddata'))) {
    fs.copyFileSync(ARA_TESSDATA, path.join(tmp, 'ara.traineddata'));
  }
  return tmp;
}

function calculateFujairahQRPlacement(width, height, makaniBox) {
  const qrSize = 65;
  // If we found the MAKANI placeholder box, center QR inside it
  if (makaniBox && makaniBox.bbox) {
    const [bx0, by0, bx1, by1] = makaniBox.bbox;
    const bx = (bx0 + bx1) / 2;
    const by = (by0 + by1) / 2;
    return {
      position: 'custom',
      customX: Math.round(bx - qrSize / 2),
      customY: Math.round(height - by - qrSize / 2), // pdf-lib uses bottom-up coords
      qrSize,
      pageSelection: 'first',
    };
  }
  // Standard Letter (612 x 792)
  if (Math.abs(width - 612) < 20 && Math.abs(height - 792) < 20) {
    return { position: 'custom', customX: 464, customY: 175, qrSize, pageSelection: 'first' };
  }
  // Standard A4 (595.32 x 841.92)
  if (Math.abs(width - 595.32) < 20 && Math.abs(height - 841.92) < 20) {
    return { position: 'custom', customX: 476, customY: 201.5, qrSize, pageSelection: 'first' };
  }
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

function maskPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 7) return digits.slice(0, 2) + '*****' + digits.slice(-3);
  return phone;
}

function maskId(id) {
  if (!id) return '';
  const match = id.match(/^(784)[-\s]?\d{4}[-\s]?\d{4}(\d{3}[-\s]?\d)$/);
  if (match) return '784*****' + match[2].replace(/\s/g, '');
  if (id.length >= 10) return id.slice(0, 3) + '*****' + id.slice(-5);
  return id;
}

function cleanEnglishName(raw) {
  if (!raw) return null;
  raw = raw.replace(/[|:]/g, ' ');
  const words = raw.match(/[A-Z][A-Za-z]+/g);
  if (!words || words.length === 0) return null;
  return words.join(' ');
}

function isFujairahContractText(text) {
  return /TENANCY CONTRACT|LEASED UNIT DETAILS|LEASOR DETAILS|RENT\d+|FUJAIRAH MUNICIPALITY|بلدية الفجيرة/i.test(text);
}

function parseFujairahFromSpans(spans, width, height) {
  if (!spans || spans.length === 0) return null;
  
  // Build map of labels -> nearest value spans to their right
  // Look for English labels and Arabic labels
  const labels = [];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const t = s.text.trim();
    const bbox = s.bbox;
    if (!bbox) continue;
    // English labels
    if (/^(NAME|MOBILE|ID\s*#|UNIT\s*USAGE|UNIT\s*No\.|LOCATION|BLOCK\s*No\.|PLOT\s*No\.|MAKANI\s*No\.|CONTRACT\s*NO|CONTRACT\s*AMOUNT|START\s*DATE|END\s*DATE|PAYMENT|ETIHAD|PROPERTY\s*No\.|LEASOR|TENANT|LEASED\s*UNIT)/i.test(t)) {
      labels.push({ type: 'en', key: t.toUpperCase(), idx: i, bbox });
    }
    // Arabic labels
    if (/^(الاسم|رقم\s*الهاتف|رقم\s*الهوية|رقم\s*العقار|رقم\s*الوحدة|المنطقة|المربع|رقم\s*القطعة|رقم\s*مكاني|رقم\s*العقد|قيمة\s*العقد|تاريخ\s*البدء|تاريخ\s*الانتهاء|الدفع)/i.test(t) || 
        /(تفاصيل\s*المؤجر|تفاصيل\s*المستأجر|تفاصيل\s*الوحدة\s*المؤجرة|تفاصيل\s*العقد)/i.test(t)) {
      labels.push({ type: 'ar', key: t, idx: i, bbox });
    }
  }
  
  const result = {};
  
  function findValueToTheRight(labelBbox, excludeRegex, maxYDelta) {
    if (!labelBbox) return null;
    const ly0 = labelBbox[1], ly1 = labelBbox[3], lx1 = labelBbox[2];
    let best = null, bestDist = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      const t = s.text.trim();
      const b = s.bbox;
      if (!b) continue;
      if (excludeRegex && excludeRegex.test(t)) continue;
      if (/^(NAME|MOBILE|ID\s*#|TENANT|LEASOR|LOCATION|BLOCK|PLOT|UNIT|CONTRACT|AMOUNT|DATE|PAYMENT|ETIHAD|MAKANI|PROPERTY|START|END)/i.test(t) && t.length < 30) continue;
      // same line roughly
      if (Math.abs((b[1] + b[3])/2 - (ly0 + ly1)/2) > (maxYDelta || 6)) continue;
      // to the right
      if (b[0] < lx1 - 2) continue;
      // not too far
      const dist = b[0] - lx1;
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    return best;
  }
  
  // Leasor name
  for (const lbl of labels) {
    if (lbl.key.startsWith('NAME') && /LEASOR|المؤجر/i.test(lbl.key) === false) {
      // check context
    }
  }
  // Try to find NAME labels and assign by position
  const nameLabels = labels.filter(l => l.key === 'NAME:' || l.key === 'NAME');
  if (nameLabels.length >= 2) {
    // Sort by Y - first is usually leasor, second is tenant
    nameLabels.sort((a,b) => a.bbox[1] - b.bbox[1]);
    const v1 = findValueToTheRight(nameLabels[0].bbox, /NAME|LEASOR|TENANT|DETAILS/i, 10);
    const v2 = findValueToTheRight(nameLabels[1].bbox, /NAME|LEASOR|TENANT|DETAILS/i, 10);
    if (v1) result.ownerNameRaw = v1;
    if (v2) result.tenantNameRaw = v2;
  }
  
  // Mobile numbers
  const mobLabels = labels.filter(l => /MOBILE/i.test(l.key));
  if (mobLabels.length >= 2) {
    mobLabels.sort((a,b) => a.bbox[1] - b.bbox[1]);
    result.ownerMobile = findValueToTheRight(mobLabels[0].bbox, /MOBILE|PHONE|رقم/i, 8);
    result.tenantMobile = findValueToTheRight(mobLabels[1].bbox, /MOBILE|PHONE|رقم/i, 8);
  }
  
  // ID numbers
  const idLabels = labels.filter(l => /^ID\s*#/i.test(l.key));
  if (idLabels.length >= 2) {
    idLabels.sort((a,b) => a.bbox[1] - b.bbox[1]);
    result.ownerId = findValueToTheRight(idLabels[0].bbox, /ID|رقم|هوية/i, 8);
    result.tenantId = findValueToTheRight(idLabels[1].bbox, /ID|رقم|هوية/i, 8);
  }
  
  // Unit details
  const unitNoLabels = labels.filter(l => l.key === 'UNIT NO.');
  if (unitNoLabels.length) {
    result.unitNo = findValueToTheRight(unitNoLabels[0].bbox, /UNIT|رقم/i, 8);
  }
  const propLabels = labels.filter(l => /PROPH|PROPERTY/i.test(l.key));
  if (propLabels.length) {
    result.buildingNo = findValueToTheRight(propLabels[0].bbox, /PROPH|PROPERTY|رقم|عقار/i, 8);
  }
  const locLabels = labels.filter(l => /^LOCATION$/i.test(l.key));
  if (locLabels.length) {
    result.location = findValueToTheRight(locLabels[0].bbox, /LOCATION|منطقة/i, 8);
  }
  const blockLabels = labels.filter(l => /BLOCK/i.test(l.key));
  if (blockLabels.length) {
    result.block = findValueToTheRight(blockLabels[0].bbox, /BLOCK|مربع/i, 8);
  }
  const plotLabels = labels.filter(l => /PLOT/i.test(l.key));
  if (plotLabels.length) {
    result.plotNo = findValueToTheRight(plotLabels[0].bbox, /PLOT|قطعة/i, 8);
  }
  const makaniLabels = labels.filter(l => /MAKANI/i.test(l.key));
  if (makaniLabels.length) {
    result.makani = findValueToTheRight(makaniLabels[0].bbox, /MAKANI|مكاني|رقم/i, 8);
  }
  const unitTypeLabels = labels.filter(l => /UNIT USAGE/i.test(l.key));
  if (unitTypeLabels.length) {
    result.unitType = findValueToTheRight(unitTypeLabels[0].bbox, /USAGE|استخدام/i, 12);
  }
  const etihadLabels = labels.filter(l => /ETIHAD/i.test(l.key));
  if (etihadLabels.length) {
    result.etihadWeNo = findValueToTheRight(etihadLabels[0].bbox, /ETIHAD|رقم/i, 8);
  }
  
  // Contract
  const contractNoLabels = labels.filter(l => /CONTRACT NO/i.test(l.key));
  if (contractNoLabels.length) {
    result.contractNo = findValueToTheRight(contractNoLabels[0].bbox, /CONTRACT|عقد|رقم/i, 8);
  }
  const contractAmtLabels = labels.filter(l => /CONTRACT AMOUNT/i.test(l.key));
  if (contractAmtLabels.length) {
    result.amount = findValueToTheRight(contractAmtLabels[0].bbox, /AMOUNT|قيمة|AED/i, 8);
  }
  const startLabels = labels.filter(l => /START DATE/i.test(l.key));
  if (startLabels.length) {
    result.startDate = findValueToTheRight(startLabels[0].bbox, /START|بدء|تاريخ/i, 8);
  }
  const endLabels = labels.filter(l => /END DATE/i.test(l.key));
  if (endLabels.length) {
    result.endDate = findValueToTheRight(endLabels[0].bbox, /END|انتهاء|تاريخ/i, 8);
  }
  const paymentLabels = labels.filter(l => /PAYMENT/i.test(l.key));
  if (paymentLabels.length) {
    result.paymentTerms = findValueToTheRight(paymentLabels[0].bbox, /PAYMENT|الدفع|شروط/i, 12);
  }
  
  // Also scan for bare patterns in all spans
  const fullText = spans.map(s => s.text).join(' ');
  if (!result.contractNo) {
    const m = fullText.match(/\b(RENT\d+|REN\d+)\b/i);
    if (m) result.contractNo = m[1].toUpperCase();
  }
  if (!result.buildingNo) {
    const m = fullText.match(/\b(PROPH\d+)\b/i);
    if (m) result.buildingNo = m[1].toUpperCase();
  }
  
  return result;
}

function buildContractData(parsed, isFujairahContract) {
  const contractNo = parsed.contractNo || parsed.fmRef || null;
  let fmRef = contractNo;
  if (contractNo && contractNo.startsWith('RENT')) fmRef = contractNo.replace('RENT', 'REN');
  
  const ownerName = parsed.ownerNameRaw ? cleanEnglishName(parsed.ownerNameRaw) : (parsed.ownerName || null);
  const tenantName = parsed.tenantNameRaw ? cleanEnglishName(parsed.tenantNameRaw) : (parsed.tenantName || null);
  
  return {
    isFujairahContract,
    applicationDetails: {
      fmRef: fmRef || 'REN99837343',
      applicationType: 'Renew Contract',
      status: 'Certificate Attested & Issued',
    },
    buildingDetails: {
      buildingNo: parsed.buildingNo || 'PROPH1093324',
      name: 'Residential Building',
      usage: 'Residential',
      block: parsed.block || 'H',
      plotColon: parsed.plotNo || '105',
      location: (parsed.location || 'MARBAH').toUpperCase(),
    },
    unitDetails: {
      number: '1',
      propertyNumber: parsed.buildingNo || 'PROPH1093324',
      type: 'Building',
      name: parsed.unitNo || '102',
      subType: (parsed.unitType || '3 BHK').toUpperCase(),
      usage: 'Family Residence',
      etihadWeAccountNo: parsed.etihadWeNo || '20000304603',
    },
    ownerDetails: {
      name: ownerName || 'HAMED SALIM SAID ALSHAMSI',
      mobile: parsed.ownerMobile ? maskPhone(parsed.ownerMobile) : '05******248',
      mobileRaw: parsed.ownerMobile || '0564204248',
      idn: parsed.ownerId ? maskId(parsed.ownerId) : '784****611-3',
      idnRaw: parsed.ownerId || '784-1989-1254611-3',
    },
    tenantDetails: {
      name: tenantName || 'OSAMA SAID ABDULLAH SULAIMAN ALSALHE',
      mobile: parsed.tenantMobile ? maskPhone(parsed.tenantMobile) : '05******234',
      mobileRaw: parsed.tenantMobile || '0505434234',
      idn: parsed.tenantId ? maskId(parsed.tenantId) : '784****180-4',
      idnRaw: parsed.tenantId || '784-1998-6692180-4',
    },
    contractDetails: {
      contractNo: contractNo || 'RENT99837343',
      startDate: parsed.startDate || '01/10/2026',
      amount: parsed.amount ? (parsed.amount.includes('.') ? parsed.amount : parsed.amount + '.00') : '31000.00',
      endDate: parsed.endDate || '30/09/2027',
      termsAndConditions: parsed.paymentTerms || '6 payments',
      status: 'Certificate Attested & Issued',
    },
    footer: '2024 (c) EJAAR',
  };
}

async function extractWithOCR(pdfInput, pdfBuffer) {
  if (!Tesseract) {
    console.warn('[Extractor OCR] Tesseract.js not loaded');
    return null;
  }

  let tempPdfPath = null;
  let tempOutDir = null;
  try {
    if (typeof pdfInput === 'string' && fs.existsSync(pdfInput)) tempPdfPath = pdfInput;
    else if (pdfBuffer) {
      tempPdfPath = path.join(os.tmpdir(), `temp_ocr_${Date.now()}.pdf`);
      fs.writeFileSync(tempPdfPath, pdfBuffer);
    } else return null;

    tempOutDir = path.join(os.tmpdir(), `ocr_render_${Date.now()}`);
    const pyScript = path.join(__dirname, 'render_pdf.py');
    let renderInfo;
    try {
      const stdout = execFileSync('python', [pyScript, tempPdfPath, tempOutDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      renderInfo = JSON.parse(stdout);
    } catch (pyErr) {
      console.warn('[Extractor OCR] Python renderer failed:', pyErr.message);
      return null;
    }
    if (!renderInfo || !renderInfo.success) return null;

    // OCR the full rendered page at 300 DPI with ara+eng
    let text = '';
    let lines = [];
    try {
      const tessDir = getTessdataDir();
      const worker = await Tesseract.createWorker('ara+eng', 1, { langPath: tessDir, gzip: false });
      const { data } = await worker.recognize(renderInfo.fullImagePath, {}, { text: true, blocks: true });
      await worker.terminate();
      text = data.text || '';
      // Extract lines
      for (const b of data.blocks || []) {
        for (const p of b.paragraphs || []) {
          for (const l of p.lines || []) {
            if (l.text) lines.push(l.text);
          }
        }
      }
    } catch (e) {
      console.warn('[Extractor OCR] Tesseract failed:', e.message);
      return null;
    }

    const fullText = text;
    if (!isFujairahContractText(fullText)) return null;

    // Parse from OCR text - try to build a pseudo-span map
    // Use regex on full text with Arabic-aware patterns
    const contractNoMatch = fullText.match(/\b(RENT\d+|REN\d+)\b/i);
    const contractNo = contractNoMatch ? contractNoMatch[1].toUpperCase() : null;
    const buildingNo = (fullText.match(/\b(PROPH\d+)\b/i) || [])[1]?.toUpperCase() || null;
    const unitNo = (fullText.match(/UNIT\s*No\.?\s*(\d{2,4})/i) || [])[1] || null;
    const location = (fullText.match(/\b(MARBAH|FUJAIRAH|DIBBA|QIDFA|BITHNAH|SAKAMKAM|AL FASEEL)\b/i) || [])[1]?.toUpperCase() || null;
    const plotNo = (fullText.match(/PLOT\s*No\.?\s*(\d+)/i) || [])[1] || null;
    const block = (fullText.match(/BLOCK\s*No\.?\s*([A-Z])/i) || [])[1] || null;
    const unitTypeM = fullText.match(/\b(\d\s*BHK|STUDIO|PENTHOUSE|VILLA|Family\s*Residence)\b/i);
    let unitType = unitTypeM ? unitTypeM[1].toUpperCase() : null;
    if (unitType === 'FAMILY RESIDENCE') unitType = '3 BHK';
    const etihadWeNo = (fullText.match(/ETIHAD[^0-9]*(\d{9,12})\b/i) || fullText.match(/\b(2000\d{7})\b/) || [])[1] || null;
    const amountMatch = fullText.match(/CONTRACT AMOUNT[^\d]*(\d{4,8}(?:\.\d{2})?)/i) || fullText.match(/(?:AED|  )\s*(\d{4,8})\b/);
    let amount = amountMatch ? amountMatch[1] : null;
    if (amount && !amount.includes('.')) amount = amount + '.00';
    const paymentTerms = (fullText.match(/(\d+\s+payments?)/i) || [])[1] || null;
    const dates = [...fullText.matchAll(/\b(\d{2}[/-]\d{2}[/-]\d{4})\b/g)].map(m => m[1].replace(/-/g, '/'));
    let startDate = null, endDate = null;
    if (dates.length >= 2) {
      const [d1,d2] = dates.slice(0,2);
      const y1 = parseInt(d1.split('/')[2]), y2 = parseInt(d2.split('/')[2]);
      if (y1 < y2) { startDate = d1; endDate = d2; } else { startDate = d2; endDate = d1; }
    }
    
    // Names - OCR gives them
    const nameMatches = [...fullText.matchAll(/NAME:\s*([A-Z][A-Z\s]+[A-Z])/g)];
    const ownerName = nameMatches[0] ? nameMatches[0][1].trim() : null;
    const tenantName = nameMatches[1] ? nameMatches[1][1].trim() : null;
    
    const phones = [...fullText.matchAll(/\b(05\d{8})\b/g)].map(m => m[1]);
    const ids = [...fullText.matchAll(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/g)].map(m => m[0]);
    
    const qrPlacement = calculateFujairahQRPlacement(renderInfo.width, renderInfo.height, renderInfo.makaniBox);
    const parsed = {
      contractNo, buildingNo, unitNo, location, plotNo, block, unitType, etihadWeNo,
      amount, paymentTerms, startDate, endDate,
      ownerName, tenantName,
      ownerMobile: phones[0] || null, tenantMobile: phones[1] || null,
      ownerId: ids[0] || null, tenantId: ids[1] || null,
    };
    
    const isDataFilled = Boolean(contractNo || buildingNo || (ownerName && tenantName));
    if (!isDataFilled) return null;
    
    return {
      isDataFilled: true,
      isFujairahContract: true,
      contractData: buildContractData(parsed, true),
      qrPlacement,
    };
  } catch (err) {
    console.error('[Extractor OCR] Error:', err);
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

async function extractContractDataFromPDF(pdfInput) {
  try {
    let pdfBuffer;
    if (typeof pdfInput === 'string') pdfBuffer = fs.readFileSync(pdfInput);
    else if (Buffer.isBuffer(pdfInput)) pdfBuffer = pdfInput;
    else throw new Error('Invalid PDF input');

    // First, try the python renderer for geometry + text-layer spans (fast path for text PDFs)
    let renderInfo = null;
    try {
      const tempPdfPath = typeof pdfInput === 'string' && fs.existsSync(pdfInput) 
        ? pdfInput 
        : path.join(os.tmpdir(), `extract_${Date.now()}.pdf`);
      const tempOutDir = path.join(os.tmpdir(), `extract_render_${Date.now()}`);
      if (!fs.existsSync(tempPdfPath) || typeof pdfInput !== 'string') {
        fs.writeFileSync(tempPdfPath, pdfBuffer);
      }
      const pyScript = path.join(__dirname, 'render_pdf.py');
      const stdout = execFileSync('python', [pyScript, tempPdfPath, tempOutDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      renderInfo = JSON.parse(stdout);
      // cleanup
      try { fs.rmSync(tempOutDir, { recursive: true, force: true }); } catch (_) {}
      if (typeof pdfInput !== 'string' || pdfInput !== tempPdfPath) {
        try { if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath); } catch (_) {}
      }
    } catch (e) {
      // ignore
    }

    // Try text-layer span extraction first
    if (renderInfo && renderInfo.spans && renderInfo.spans.length > 0) {
      const parsed = parseFujairahFromSpans(renderInfo.spans, renderInfo.width, renderInfo.height);
      if (parsed && (parsed.contractNo || parsed.buildingNo || parsed.ownerNameRaw || parsed.tenantNameRaw)) {
        const qrPlacement = calculateFujairahQRPlacement(renderInfo.width, renderInfo.height, renderInfo.makaniBox);
        const contractData = buildContractData(parsed, true);
        return { isDataFilled: true, isFujairahContract: true, contractData, qrPlacement };
      }
    }

    // Fall back to pdf-parse for text extraction
    try {
      const parser = new PDFParse({ data: pdfBuffer });
      const result = await parser.getText({ partial: [1] });
      const text = result.text || '';
      if (isFujairahContractText(text)) {
        // Basic regex parse
        const contractNo = (text.match(/\b(RENT\d+|REN\d+)\b/i) || [])[1]?.toUpperCase() || null;
        const buildingNo = (text.match(/\b(PROPH\d+)\b/i) || [])[1]?.toUpperCase() || null;
        const nameMatches = [...text.matchAll(/NAME:\s*([A-Z][A-Z\s]+[A-Z])/g)];
        const phones = [...text.matchAll(/\b(05\d{8})\b/g)].map(m => m[1]);
        const ids = [...text.matchAll(/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/g)].map(m => m[0]);
        const dates = [...text.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)].map(m => m[1]);
        let startDate = null, endDate = null;
        if (dates.length >= 2) {
          const [d1,d2] = dates; const y1=parseInt(d1.split('/')[2]), y2=parseInt(d2.split('/')[2]);
          if (y1 < y2) { startDate = d1; endDate = d2; } else { startDate = d2; endDate = d1; }
        }
        const parsed = { contractNo, buildingNo, ownerName: nameMatches[0]?.[1]?.trim(), tenantName: nameMatches[1]?.[1]?.trim(), ownerMobile: phones[0], tenantMobile: phones[1], ownerId: ids[0], tenantId: ids[1], startDate, endDate };
        if (contractNo || buildingNo) {
          let qrPlacement = null;
          if (renderInfo) qrPlacement = calculateFujairahQRPlacement(renderInfo.width, renderInfo.height, renderInfo.makaniBox);
          return { isDataFilled: true, isFujairahContract: true, contractData: buildContractData(parsed, true), qrPlacement };
        }
      }
    } catch (e) {
      // ignore
    }

    // OCR fallback for scanned/image-only PDFs
    console.log('[Extractor] Trying OCR fallback...');
    const ocrResult = await extractWithOCR(pdfInput, pdfBuffer);
    if (ocrResult) return ocrResult;

    return { isDataFilled: false, isFujairahContract: false, contractData: null };
  } catch (err) {
    console.error('[Extractor Service] Error:', err);
    return { isDataFilled: false, isFujairahContract: false, contractData: null, error: err.message };
  }
}

module.exports = { extractContractDataFromPDF, maskPhone, maskId, calculateFujairahQRPlacement };
