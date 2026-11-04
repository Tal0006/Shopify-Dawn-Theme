export interface WhatsAppConfig {
 phoneNumberId:string;accessToken:string;verifyToken:string;appSecret:string;graphVersion:string;
}
export interface InboundMessage {from:string;id:string;timestamp:number;text?:string;replyId?:string}
export interface ReplyButton {id:string;title:string}
export interface ListRow extends ReplyButton {description?:string}
export interface WhatsAppTransport {
 sendText(to:string,text:string):Promise<void>;
 sendReplyButtons(to:string,text:string,buttons:ReplyButton[]):Promise<void>;
 sendListMessage(to:string,text:string,button:string,rows:ListRow[]):Promise<void>;
}
export type ConversationState='IDLE'|'WAITING_FOR_LIST'|'WAITING_FOR_RESOLUTION'|'WAITING_FOR_CONFIRMATION'|'CHECKOUT_READY'|'CHECKOUT_UNCERTAIN';
export interface SessionAction {kind:'resolve'|'remove'|'confirm'|'edit'|'cancel';quoteId:string;revision:number;itemIndex?:number;variantId?:string}
export interface WhatsAppSession {
 state:ConversationState;quoteId?:string;revision?:number;unresolvedItems:number[];
 lastProcessedMessageId?:string;expiresAt:number;actions:Record<string,SessionAction>;checkoutUrl?:string;
}
export interface WhatsAppSessionStore {
 get(customer:string):WhatsAppSession|undefined;
 set(customer:string,session:WhatsAppSession):void;
 delete(customer:string):void;
 claimMessage(id:string):boolean;
 allow(customer:string):boolean;
}
