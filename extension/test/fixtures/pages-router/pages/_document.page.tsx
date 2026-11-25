import Document, { Main as DocumentContent } from 'next/document';

export default class HtmlDocument extends Document {
  static getInitialProps(ctx) { return Document.getInitialProps(ctx); }
  render() { return <html><body><DocumentContent /></body></html>; }
}
