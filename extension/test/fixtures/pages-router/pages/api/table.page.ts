import { dispatch } from '../../lib/dispatch';
function create(req, res) { return res.end(); }
export default dispatch({ POST: Promise.resolve({ default: create }) });
