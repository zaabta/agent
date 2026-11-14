ALTER TABLE "users" ADD COLUMN "username" TEXT;

UPDATE "users" AS u
SET "username" = left(regexp_replace(split_part(lower(u."email"), '@', 1), '[^a-z0-9._-]', '-', 'g'), 20)
  || '-' || left(u."id"::text, 8);

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
