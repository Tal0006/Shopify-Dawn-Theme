-- Post-purchase feedback from the Shopify Thank you page (checkout UI extension "post-purchase-feedback").
-- One completed response per Shopify order. Only the order identifiers and the answers are stored: never the
-- customer's name, email, phone, address, ID number, payment details or cart contents.
CREATE TABLE IF NOT EXISTS post_purchase_feedback (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 -- Numeric part of the Order GID (gid://shopify/Order/<id>) from the extension's orderConfirmation API.
 shopify_order_id text NOT NULL CHECK (shopify_order_id ~ '^[1-9][0-9]{0,19}$'),
 -- The random order-confirmation number Shopify shows the buyer (orderConfirmation.number), when present.
 confirmation_number text NULL CHECK (confirmation_number ~ '^[A-Z0-9]{4,20}$'),
 rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
 missing_products boolean NOT NULL,
 missing_products_details text NULL CHECK (char_length(missing_products_details) BETWEEN 1 AND 500),
 encountered_problem boolean NOT NULL,
 problem_details text NULL CHECK (char_length(problem_details) BETWEEN 1 AND 1000),
 improvement_feedback text NULL CHECK (char_length(improvement_feedback) BETWEEN 1 AND 1000),
 source text NOT NULL DEFAULT 'thank-you' CHECK (source IN ('thank-you')),
 version smallint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 99),
 CONSTRAINT post_purchase_feedback_order_unique UNIQUE (shopify_order_id),
 CONSTRAINT post_purchase_feedback_missing_details CHECK (missing_products OR missing_products_details IS NULL),
 CONSTRAINT post_purchase_feedback_problem_details CHECK (encountered_problem OR problem_details IS NULL)
);
CREATE INDEX IF NOT EXISTS post_purchase_feedback_created ON post_purchase_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS post_purchase_feedback_rating ON post_purchase_feedback (rating, created_at DESC);
