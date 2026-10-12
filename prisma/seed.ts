// import { error } from 'node:console';
import {prisma} from '../src/lib/prisma.js'
// import process from 'node_modules/@types/node';

async function main(): Promise<void>{
    const users = [
        { id: "00000000-0000-4000-8000-000000000001", name: "Alice" },
    { id: "00000000-0000-4000-8000-000000000002", name: "Bob" },
    { id: "00000000-0000-4000-8000-000000000003", name: "Charlie" },
    ];

    for (const user of users){
        await prisma.user.upsert({
            where: {id:user.id},
            update: {},
            create:user,
        });
    }

    for (let number=1; number<=15;number++){
        const label = `A${number}`

        await prisma.seat.upsert({
            where: {label},
            update: {},
            create: {label}
        })
    }
    console.log("Seed complete: semo data")
}
async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        console.error("seed failed:", error)
        process.exitCode = 1;
    } finally {
        await prisma.$disconnect()
    }
}

void run().catch((error: unknown) => {
    console.error("Seed closing failed:" , error)
    process.exitCode = 1;
})