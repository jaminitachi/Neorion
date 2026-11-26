declare function wrap(handler: (request: any, response: any) => unknown): unknown;

export default wrap((request, response) => response.json({ pages: [] }));
