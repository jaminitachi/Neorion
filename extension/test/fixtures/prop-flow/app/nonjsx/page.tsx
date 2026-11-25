import { createElement } from 'react';
import { RequestPanel } from '../../ui/panel';

export default function NonJsx() {
  return createElement(RequestPanel, { endpoint: '/api/flags/nonjsx', kind: 'primary', handleSave() {} });
}
