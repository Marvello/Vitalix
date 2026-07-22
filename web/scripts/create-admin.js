import { hash } from "../src/auth/passwords.js";
import * as store from "../src/auth/store.js";
import { pool } from "../src/db.js";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("Usage: npm run create-admin -- <email> <password>");
  process.exit(2);
}
try {
  if (await store.findUserByEmail(email)) {
    console.error(`User ${email} already exists.`);
    process.exit(1);
  }
  const user = await store.createUser(email, await hash(password), "admin");
  console.log(`Created admin ${user.email} (id ${user.id}).`);
} finally {
  await pool.end();
}
