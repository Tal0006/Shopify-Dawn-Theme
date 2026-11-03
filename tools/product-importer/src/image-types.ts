import type { ProductCatalogProduct } from './catalog.js';
export interface ProductImageCandidate {
  imageUrl:string; thumbnailUrl?:string; sourcePageUrl?:string; sourceDomain?:string; source:string;
  confidence?:number; warning?:string; title?:string; relevanceScore?:number;
  originalWidth?:number; originalHeight?:number; isProduct?:boolean;
}
export interface ProductImageResult {
  imageUrl:string; source:string; sourcePageUrl?:string; confidence?:number; warning?:string;
  candidates?:ProductImageCandidate[];
}
export interface ProductImageDiscovery { image:ProductImageResult | null; candidates:ProductImageCandidate[] }
export interface ProductImageProvider {
  findByBarcode(barcode:string,product:ProductCatalogProduct):Promise<ProductImageResult | null>;
  findCandidatesByBarcode?(barcode:string,product:ProductCatalogProduct):Promise<ProductImageCandidate[]>;
  discoverByBarcode?(barcode:string,product:ProductCatalogProduct):Promise<ProductImageDiscovery>;
}
export interface ValidatedImage { imageUrl:string; warning?:string }
export interface ImageUrlValidator { validate(value:unknown):Promise<ValidatedImage> }
