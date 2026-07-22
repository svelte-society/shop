ALTER TABLE checkout_draft_lines
ADD COLUMN production_json TEXT NOT NULL DEFAULT '{"mockupPlacements":{},"threadColors":{}}';

ALTER TABLE order_lines
ADD COLUMN production_json TEXT NOT NULL DEFAULT '{"mockupPlacements":{},"threadColors":{}}';
