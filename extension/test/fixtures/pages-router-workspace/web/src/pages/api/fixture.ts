import { dispatch } from '@fixture/dispatch';

function post(req, res) { return res.end(); }
export default dispatch({ POST: Promise.resolve({ default: post }) });
