import { prisma } from '../src/lib/prisma'

async function book(): Promise<void> {
    const seat = await prisma.seat.findUniqueOrThrow({
        where: {label: "AI"},
        include: {booking:true},
    });
    
    if (seat.booking){
        throw new Error("A1 is already ybooked. Choose another unbooked seat.")
    }
}
