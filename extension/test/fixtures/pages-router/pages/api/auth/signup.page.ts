function ensurePost(request) {
  if (request.method !== 'POST') throw new ApiError(405);
}
export default function signup(req, res) {
  ensurePost(req);
  return res.end();
}
