import { createElement } from 'react';
import { RequestPanel } from '../../ui/panel';

declare function getSettings(): Parameters<typeof RequestPanel>[0];

export default function NonJsxOpaque() {
  return createElement(RequestPanel, getSettings());
}
