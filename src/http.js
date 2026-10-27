'use strict';
const errorPayload = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });
// publicCode is the error code clients see; it is kept apart from database and framework codes.
const httpError = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, publicCode: code });
const normalize = (text) => text.toLowerCase().replace(/[?!.,]/g, '').replace(/\s+/g, ' ').trim();
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const pageQuery = (...names) => ({ type: 'object', properties: Object.fromEntries(names.map((name) => [name, { type: 'integer', minimum: 1, maximum: 100000 }])) });
const PAGE_SIZE = 10;

// Counts first so an out-of-range page is clamped to the last page, then fetches that page.
async function paginate(db, { count, list, values = [], page = 1 }) {
  const total = (await db.query(count, values)).rows[0].total;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(pages, Math.max(1, page));
  const n = values.length;
  const items = (await db.query(`${list} LIMIT $${n + 1} OFFSET $${n + 2}`, [...values, PAGE_SIZE, (current - 1) * PAGE_SIZE])).rows;
  return { items, page: current, pages, total };
}

module.exports = { errorPayload, httpError, normalize, idParams, pageQuery, paginate };
