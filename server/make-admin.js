// Usage: node make-admin.js <email-or-username>
// Promotes a user to admin so they can access /admin.html and the admin API routes.
const { pool } = require('./db');

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.log('Usage: node make-admin.js <email-or-username>');
    process.exit(1);
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $1', [query]);
  const user = rows[0];
  if (!user) {
    console.log('No user found matching:', query);
    process.exit(1);
  }

  await pool.query('UPDATE users SET is_admin = true, updated_at = $1 WHERE id = $2', [Date.now(), user.id]);
  console.log(`✔ ${user.username} (${user.email || user.id}) is now an admin.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
