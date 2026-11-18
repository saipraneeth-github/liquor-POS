UPDATE products
SET name = trim(regexp_replace(name, '\s*\[\s*\d+\s*cs[^\]]*\]', '', 'gi'))
WHERE name ~* '\[\s*\d+\s*cs';
--> statement-breakpoint
UPDATE brand_code_mappings
SET product_name = trim(regexp_replace(product_name, '\s*\[\s*\d+\s*cs[^\]]*\]', '', 'gi'))
WHERE product_name ~* '\[\s*\d+\s*cs';
