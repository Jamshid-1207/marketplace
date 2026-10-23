-- Категории — read-model по category.* (SD-05, п. 7): версия отсекает повторы и опоздавшие события
-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;
