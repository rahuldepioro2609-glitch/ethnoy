export const INSTITUTION_DOCUMENT_CATEGORIES = [
  'Registration Certificate',
  'PAN Card',
  'Address Proof',
  'Affiliation / Recognition Certificate',
  'Authorized Person’s ID Proof',
] as const;

export type InstitutionDocumentCategory = typeof INSTITUTION_DOCUMENT_CATEGORIES[number];
