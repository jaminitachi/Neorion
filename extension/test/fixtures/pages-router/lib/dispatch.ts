export function dispatch(handlers) {
  return async (req, res) => {
    const handler = (await handlers[req.method])?.default;
    if (!handler) return res.status(405).end();
    return handler(req, res);
  };
}
