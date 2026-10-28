import { sharedRowHtml } from './row-component.js';

/** Render the accepted shared Items, Spec and Doctrine frame from explicit presentation data [N26].
 * The browser serializes this wrapper beside the same sharedRowHtml used by the logic tests.
 */
export function recordRowHtml({ tag = 'li', classes = '', attributes, title, state, primary, secondary, rightTop = '', rightBottom = '' }) {
  return sharedRowHtml({ variant: 'record', tag, className: classes, attributesHtml: attributes, title, state,
    primaryHtml: primary, metaHtml: secondary, timeHtml: rightTop, chipHtml: rightBottom });
}
