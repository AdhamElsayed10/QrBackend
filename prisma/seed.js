const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'get ';

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    const hashed = await bcrypt.hash(password, 12);
    await prisma.admin.update({
      where: { id: existing.id },
      data: { password: hashed },
    });
    console.log(`Admin password synchronized: ${email}`);
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  const admin = await prisma.admin.create({
    data: { email, password: hashed },
  });

  console.log(`✅ Admin created: ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
