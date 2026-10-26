INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('img', 'img', true, 1048576, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = 1048576,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'Public read images from img'
  ) THEN
    CREATE POLICY "Public read images from img"
    ON storage.objects
    FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'img');
  END IF;
END
$$;
