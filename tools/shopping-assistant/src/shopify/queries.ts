const variantFields=`
 id title availableForSale requiresComponents
 image { url }
 price { amount currencyCode }
 quantityRule { minimum maximum increment }
`;
const productFields=`id handle title vendor requiresSellingPlan featuredImage { url }`;
export const SEARCH=`query ShoppingSearch($query:String!){
 search(query:$query,first:8,types:[PRODUCT],unavailableProducts:SHOW){
  pageInfo { hasNextPage }
  nodes { ... on Product { ${productFields}
   variants(first:20) { pageInfo { hasNextPage } nodes { ${variantFields} } }
  } }
 }
}`;
export const VARIANTS=`query ShoppingVariants($ids:[ID!]!){
 nodes(ids:$ids){ ... on ProductVariant { ${variantFields} product { ${productFields} } } }
}`;
export const CART_CREATE=`mutation ShoppingCart($input:CartInput!){
 cartCreate(input:$input){
  cart { id checkoutUrl totalQuantity cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
   lines(first:20){ nodes { quantity merchandise { ... on ProductVariant { id } } } }
  }
  userErrors { code } warnings { code }
 }
}`;
