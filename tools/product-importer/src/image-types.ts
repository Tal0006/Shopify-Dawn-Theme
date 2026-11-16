import type { ProductCatalogProduct } from './catalog.js';
import type { ImageSourcePolicy,ImageUsagePolicy } from './image-policy.js';
export type { ImageUsagePolicy } from './image-policy.js';
/** Provenance fields. usagePolicy/autoAttachAllowed are always recomputed by ImageSourcePolicy. */
export interface ProductImageCandidate {
  imageUrl:string; thumbnailUrl?:string; sourcePageUrl?:string; sourceDomain?:string; source:string;
  confidence?:number; warning?:string; title?:string; relevanceScore?:number;
  originalWidth?:number; originalHeight?:number; isProduct?:boolean;
  usagePolicy?:ImageUsagePolicy; autoAttachAllowed?:boolean; reason?:string;
}
export interface ProductImageResult {
  imageUrl:string; source:string; sourcePageUrl?:string; sourceDomain?:string; confidence?:number; warning?:string;
  candidates?:ProductImageCandidate[];
  usagePolicy?:ImageUsagePolicy; autoAttachAllowed?:boolean; reason?:string;
}
export interface ProductImageDiscovery { image:ProductImageResult | null; candidates:ProductImageCandidate[] }
export interface ProductImageProvider {
  /** The usage policy a chain applied; the importer reuses it for its own server-side checks. */
  readonly policy?:ImageSourcePolicy;
  findByBarcode(barcode:string,product:ProductCatalogProduct):Promise<ProductImageResult | null>;
  findCandidatesByBarcode?(barcode:string,product:ProductCatalogProduct):Promise<ProductImageCandidate[]>;
  discoverByBarcode?(barcode:string,product:ProductCatalogProduct):Promise<ProductImageDiscovery>;
}
export interface ValidatedImage { imageUrl:string; warning?:string }
export interface ImageUrlValidator { validate(value:unknown):Promise<ValidatedImage> }
