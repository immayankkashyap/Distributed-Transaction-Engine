/*
  Warnings:

  - You are about to drop the column `status` on the `Seat` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,key]` on the table `IdempotencyKey` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[label]` on the table `Seat` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `seatId` to the `IdempotencyKey` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `IdempotencyKey` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "IdempotencyKey_key_key";

-- AlterTable
ALTER TABLE "IdempotencyKey" ADD COLUMN     "seatId" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Seat" DROP COLUMN "status";

-- DropEnum
DROP TYPE "SeatStatus";

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Seat_label_key" ON "Seat"("label");

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
