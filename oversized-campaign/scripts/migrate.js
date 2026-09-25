// Applies pending migrations. The server also does this on start.
import { db, migrate } from '../src/db.js';

const ran = migrate(db);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
