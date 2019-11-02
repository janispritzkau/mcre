import { Client, PacketWriter, State, Server } from "mcproto"
import { update } from "./profile"
import { readFileSync, writeFileSync } from "fs"
import { re } from "../src"
import * as dotenv from "dotenv"

dotenv.config()

update(JSON.parse(readFileSync("data/profile.json", "utf-8")), process.env.USERNAME!, process.env.PASSWORD!).then(async profile => {
    writeFileSync("data/profile.json", JSON.stringify(profile))

    const client = await Client.connect("9b9t.com", 25565, {
        accessToken: profile.accessToken,
        profile: profile.id
    })

    client.send(new PacketWriter(0x0).writeVarInt(340)
        .writeString("localhost").writeUInt16(client.socket.remotePort!)
        .writeVarInt(State.Login))

    client.send(new PacketWriter(0x0).writeString(profile.name))

    const loginStart = await client.nextPacket(0x2, false)
    const uuid = loginStart.readString()
    const username = loginStart.readString()

    const proxy = re(client, uuid, username)

    const server = await new Server(async conn => {
        await conn.nextPacket(0x0)

        if (conn.state == State.Status) {
            conn.onPacket(0x0, () => conn.send(new PacketWriter(0x0).writeJSON({
                version: { name: "1.12.2", protocol: 340 },
                players: { online: 0, max: -1 },
                description: { text: "re_" }
            })))
            conn.onPacket(0x1, packet => {
                conn.send(new PacketWriter(0x1).writeInt64(packet.readInt64()))
            })
            return
        }

        const username = (await conn.nextPacket(0x0)).readString()
        // await conn.encrypt(username, true)
        conn.setCompression(256)

        proxy.connect(conn)
    }).listen(25565)

    client.on("end", () => {
        server.close()
    })
})
