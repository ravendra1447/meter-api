function ok(res, data, message = null, status = 200) {
  const body = { success: true, data };
  if (message) body.message = message;
  return res.status(status).json(body);
}

function fail(res, message, status = 400) {
  return res.status(status).json({ success: false, message });
}

function paginate(rows, total, page, perPage) {
  return {
    current_page: page,
    data: rows,
    per_page: perPage,
    total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    from: total ? (page - 1) * perPage + 1 : 0,
    to: Math.min(page * perPage, total),
  };
}

module.exports = { ok, fail, paginate };
