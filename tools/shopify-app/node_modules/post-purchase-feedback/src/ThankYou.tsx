// Entry for the purchase.thank-you.block.render target (Thank you page, after the order is placed).
import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {FeedbackBlock} from './FeedbackBlock';

export default async function extension(){
 render(<FeedbackBlock api={shopify}/>,document.body);
}
