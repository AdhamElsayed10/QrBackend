const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULTS = {
  qrPosition: 'custom',
  qrSize: 50,
  customX: 48,
  customY: 620,
  applyTo: 'all',
};

exports.getSettings = async (req, res) => {
  try {
    let settings = await prisma.qRSettings.findFirst();
    if (!settings) {
      settings = await prisma.qRSettings.create({ data: DEFAULTS });
    }
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    let settings = await prisma.qRSettings.findFirst();

    if (settings) {
      settings = await prisma.qRSettings.update({
        where: { id: settings.id },
        data: DEFAULTS,
      });
    } else {
      settings = await prisma.qRSettings.create({
        data: DEFAULTS,
      });
    }

    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};
