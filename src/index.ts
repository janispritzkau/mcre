import { Client, PacketReader, PacketWriter, Packet, ServerConnection } from "mcproto"
import * as nbt from "nbt-ts"
import { SSL_OP_SSLEAY_080_CLIENT_DH_BUG } from "constants"

interface PlayerListItem {
    name: string
    gamemode: number
    ping: number
    properties: { name: string, value: string, signature?: string }[]
    displayName?: string
}

interface Team {
    displayName: string
    prefix: string
    suffix: string
    flags: number
    nameTagVisibility: string
    collisionRule: string
    color: number
    members: Set<string>
}

interface BossBar {
    title: string
    health: number
    color: number
    division: number
    flags: number
}

interface MapData {
    scale: number
    showIcons: boolean
    icons: Buffer[]
    data: number[]
}

interface Item {
    id: number
    count: number
    damage: number
    tag: nbt.Tag | null
}

interface Entity {
    type: "object" | "orb" | "global" | "mob" | "painting" | "player"
    spawn: PacketReader
    passengers?: number[]
    properties?: Map<string, Buffer>
    metadata?: Map<number, Buffer>
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    yaw?: number
    pitch?: number
    headPitch?: number
}

interface Player {
    x: number
    y: number
    z: number
    yaw: number
    pitch: number
}

type Chunk = PacketReader[]

export function re(client: Client, uuid: string, username: string) {
    const player: Player = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }
    const inventory = new Map<number, Item>()

    const players = new Map<string, PlayerListItem>()
    const teams = new Map<string, Team>()
    const bossBars = new Map<string, BossBar>()
    const maps = new Map<number, MapData>()

    const chunks = new Map<number, Map<number, Chunk>>()
    const entities = new Map<number, Entity>()
    const objects = new Map<number, number>()

    let eid = 0
    let gamemode = 0
    let dimension = 0
    let difficulty = 0
    let levelType = "default"

    let health: PacketReader
    let xp: PacketReader
    let tab: PacketReader
    let playerAbilities: PacketReader
    let time: PacketReader
    let spawn: PacketReader

    let heldItem = 0
    let raining = false
    let fadeValue = 0
    let fadeTime = 0

    let riding: number | null = null

    function getChunk(x: number, z: number) {
        const m = chunks.get(x)
        if (m) return m.get(z)
    }

    function deleteChunk(x: number, z: number) {
        const m = chunks.get(x)
        if (m) {
            m.delete(z)
            if (m.size == 0) chunks.delete(x)
        }
    }

    function setChunk(x: number, z: number, chunk: Chunk) {
        const m = chunks.get(x)
        if (!m) return (chunks.set(x, new Map([[z, chunk]])), chunk)
        return (m.set(z, chunk), chunk)
    }

    // spawn object
    client.onPacket(0x0, packet => {
        const eid = packet.readVarInt()
        packet.offset += 16
        objects.set(eid, packet.readInt8())
        entities.set(eid, {
            type: "object", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
            yaw: packet.readInt8(), pitch: packet.readInt8(),
            vx: (packet.offset += 4, packet.readInt16()), vy: packet.readInt16(), vz: packet.readInt16(),
            spawn: packet
        })
    })

    // spawn experience orb
    client.onPacket(0x1, packet => {
        const eid = packet.readVarInt()
        entities.set(eid, {
            type: "orb", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
            spawn: packet
        })
    })

    // spawn global entity
    client.onPacket(0x2, packet => {
        const eid = packet.readVarInt()
        packet.offset += 1
        entities.set(eid, {
            type: "global", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
            spawn: packet
        })
    })

    // spawn mob
    client.onPacket(0x3, packet => {
        const eid = packet.readVarInt()
        packet.offset += 16, packet.readVarInt()
        entities.set(eid, {
            type: "mob", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
            yaw: packet.readInt8(), pitch: packet.readInt8(), headPitch: packet.readInt8(),
            vx: packet.readInt16(), vy: packet.readInt16(), vz: packet.readInt16(),
            spawn: packet
        })
    })

    // spawn painting
    client.onPacket(0x4, packet => {
        const eid = packet.readVarInt()
        packet.offset += 16, packet.readVarInt()
        entities.set(eid, { type: "painting", spawn: packet })
    })

    // spawn player
    client.onPacket(0x5, packet => {
        const eid = packet.readVarInt()
        packet.offset += 16
        entities.set(eid, {
            type: "player", x: packet.readDouble(), y: packet.readDouble(), z: packet.readDouble(),
            yaw: packet.readInt8(), pitch: packet.readInt8(),
            spawn: packet
        })
    })

    // update block entity
    // block change
    client.on("packet", packet => {
        if (packet.id != 0x9 && packet.id != 0xb) return
        const pos = packet.readPosition()
        const chunk = getChunk(Math.floor(pos.x / 16), Math.floor(pos.z / 16))
        if (chunk) chunk.push(packet)
    })

    // boss bar
    client.onPacket(0xc, packet => {
        const uuid = packet.read(16).toString("hex")
        const action = packet.readVarInt()
        if (action == 0) return bossBars.set(uuid, {
            title: packet.readString(),
            health: packet.readFloat(),
            color: packet.readVarInt(),
            division: packet.readVarInt(),
            flags: packet.readUInt8()
        })
        const bossBar = bossBars.get(uuid)
        if (!bossBar) return
        if (action == 1) {
            bossBars.delete(uuid)
        } else if (action == 2) {
            bossBar.health = packet.readFloat()
        } else if (action == 3) {
            bossBar.title = packet.readString()
        } else if (action == 4) {
            bossBar.color = packet.readVarInt()
            bossBar.division = packet.readVarInt()
        } else if (action == 5) {
            bossBar.flags = packet.readUInt8()
        }
    })

    // server difficulty
    client.onPacket(0xd, packet => {
        difficulty = packet.readUInt8()
    })

    // multi block change
    client.onPacket(0x10, packet => {
        const chunk = getChunk(packet.readInt32(), packet.readInt32())
        if (chunk) chunk.push(packet)
    })

    // window items
    client.onPacket(0x14, packet => {
        if (packet.readUInt8() != 0) return
        const count = packet.readUInt16()
        for (let i = 0; i < count; i++) {
            const id = packet.readInt16()
            if (id == -1) {
                inventory.delete(i)
                continue
            }
            const count = packet.readInt8()
            const damage = packet.readInt16()
            const { length, value } = nbt.decode(packet.buffer.slice(packet.offset))
            packet.offset += length
            inventory.set(i, { id, count, damage, tag: value })
        }
    })

    // set slot
    client.onPacket(0x16, packet => {
        if (packet.readInt8() != 0) return
        const slot = packet.readInt16()
        const id = packet.readInt16()
        if (id == -1) return inventory.delete(slot)
        const count = packet.readInt8()
        const damage = packet.readInt16()
        const { length, value } = nbt.decode(packet.buffer.slice(packet.offset))
        packet.offset += length
        inventory.set(slot, { id, count, damage, tag: value })
    })

    // plugin channel
    client.onPacket(0x18, packet => {
        const channel = packet.readString()
        const data = packet.read(packet.buffer.length - packet.offset)
    })

    // TODO: 0x1b entity status

    // explosion
    client.onPacket(0x1c, packet => {
        const chunk = getChunk(Math.floor(packet.readFloat() / 16), Math.floor((packet.readFloat(), packet.readFloat()) / 16))
        if (chunk) chunk.push(packet)
    })

    // unload chunk
    client.onPacket(0x1d, packet => {
        deleteChunk(packet.readInt32(), packet.readInt32())
    })

    // change gamestate
    client.onPacket(0x1e, packet => {
        const reason = packet.readUInt8()
        const value = packet.readFloat()
        if (reason == 1) {
            raining = false
        } else if (reason == 2) {
            raining = true
        } else if (reason == 3) {
            gamemode = value
        } else if (reason == 7) {
            fadeValue = value
        } else if (reason == 8) {
            fadeTime = value
        }
    })

    // chunk data
    client.onPacket(0x20, packet => {
        const chunkX = packet.readInt32()
        const chunkZ = packet.readInt32()
        const fullChunk = packet.readBool()
        if (fullChunk) {
            setChunk(chunkX, chunkZ, [packet])
        } else {
            const chunk = getChunk(chunkX, chunkZ)
            if (chunk) chunk.push(packet)
        }
    })

    // join game
    client.onPacket(0x23, packet => {
        eid = packet.readInt32()
        gamemode = packet.readUInt8()
        dimension = packet.readInt32()
        difficulty = packet.readUInt8()
        levelType = (packet.readUInt8(), packet.readString())
    })

    // map
    client.onPacket(0x24, packet => {
        const id = packet.readVarInt()
        const scale = packet.readUInt8()
        const showIcons = packet.readBool()
        const icons = [...Array(packet.readVarInt())].map(() => packet.read(3))
        if (!maps.has(id)) maps.set(id, { scale, showIcons, icons, data: Array(16384).fill(0) })
        const cols = packet.readUInt8()
        if (cols == 0) return
        const rows = packet.readUInt8()
        const x = packet.readUInt8()
        const z = packet.readUInt8()
        const data = packet.read(packet.readVarInt())
        const map = maps.get(id)!
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
                map.data[(z + r) * 128 + x + c] = data[r * cols + c]
            }
        }
    })

    // entity look and relative move
    client.on("packet", packet => {
        if (![0x26, 0x27].includes(packet.id)) return
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        entity.x! += packet.readInt16() / 4096
        entity.y! += packet.readInt16() / 4096
        entity.z! += packet.readInt16() / 4096
        if (packet.id == 0x27) {
            entity.yaw = packet.readInt8()
            entity.pitch = packet.readInt8()
        }
    })

    // entity look
    client.onPacket(0x28, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        entity.yaw = packet.readInt8()
        entity.pitch = packet.readInt8()
    })

    // vehicle move
    client.onPacket(0x29, packet => {
        const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
        const entity = entities.get(riding!)
        if (entity) entity.x = x, entity.y = y, entity.z = z
        player.x = x, player.y = y, player.z = z
    })

    // player abilities
    client.onPacket(0x2c, packet => playerAbilities = packet)

    // player list item
    client.onPacket(0x2e, packet => {
        const action = packet.readVarInt()
        for (let i = packet.readVarInt(); i--;) {
            const uuid = packet.read(16).toString("hex")
            if (action == 0) {
                const name = packet.readString(), properties = []
                for (let j = packet.readVarInt(); j--;) properties.push({
                    name: packet.readString(), value: packet.readString(),
                    signature: packet.readBool() ? packet.readString() : undefined
                })
                players.set(uuid, { name, gamemode: packet.readVarInt(), ping: packet.readVarInt(), properties })
                if (packet.readBool()) players.get(uuid)!.displayName = packet.readJSON()
            } else if (action == 1) {
                if (!players.has(uuid)) continue
                players.get(uuid)!.gamemode = packet.readVarInt()
            } else if (action == 2) {
                if (!players.has(uuid)) continue
                players.get(uuid)!.ping = packet.readVarInt()
            } else if (action == 3) {
                if (!players.has(uuid)) continue
                if (!packet.readBool()) delete players.get(uuid)!.displayName
                else players.get(uuid)!.displayName = packet.readString()
            } else if (action == 4) {
                players.delete(uuid)
            }
        }
    })

    // player position and look
    client.onPacket(0x2f, packet => {
        const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
        const yaw = packet.readFloat(), pitch = packet.readFloat()
        const flags = packet.readUInt8(), teleportId = packet.readVarInt()
        player.x = (flags & 0x01 ? player.x : 0) + x
        player.y = (flags & 0x02 ? player.y : 0) + y
        player.z = (flags & 0x04 ? player.z : 0) + z
        player.yaw = (flags & 0x08 ? player.yaw : 0) + yaw
        player.pitch = (flags & 0x10 ? player.pitch : 0) + pitch
        client.send(new PacketWriter(0x0).writeVarInt(teleportId))
    })

    // TODO: 0x31 unlock recipes

    // destroy entities
    client.onPacket(0x32, packet => {
        for (let i = packet.readVarInt(); i--;) {
            const eid = packet.readVarInt()
            entities.delete(eid)
            objects.delete(eid)
        }
    })

    // TODO: 0x33 remove entity effect
    // TODO: 0x34 resource pack send

    // respawn
    client.onPacket(0x35, packet => {
        dimension = packet.readInt32()
        difficulty = packet.readUInt8()
        gamemode = packet.readUInt8()
        levelType = packet.readString()
        maps.clear()
    })

    // entity head look
    client.onPacket(0x36, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        entity.headPitch = packet.readInt8()
    })

    // TODO: 0x38 world border
    // TODO: 0x39 camera

    // held item change
    client.onPacket(0x3a, packet => heldItem = packet.readInt8())

    // TODO: 0x3b display scoreboard

    // entity metadata
    client.onPacket(0x3c, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        if (!entity.metadata) entity.metadata = new Map()
        while (true) {
            const index = packet.readUInt8()
            if (index == 0xff) break
            const start = packet.offset
            const type = packet.readVarInt()
            switch (type) {
                case 0: case 6: packet.offset += 1; break
                case 1: case 10: case 12: packet.readVarInt(); break
                case 2: packet.offset += 4; break
                case 3: case 4: packet.readString(); break
                case 5: if (packet.readInt16() != -1) {
                    packet.offset += nbt.decode(packet.buffer.slice(packet.offset + 3)).length + 3
                }; break
                case 7: packet.offset += 12; break
                case 8: packet.offset += 8; break
                case 9: if (packet.readBool()) packet.offset += 8; break
                case 11: if (packet.readBool()) packet.offset += 16; break
                case 13: packet.offset += nbt.decode(packet.buffer.slice(packet.offset)).length; break
            }
            entity.metadata.set(index, packet.buffer.slice(start, packet.offset))
        }
    })

    // TODO: 0x3d attach entity

    // entity velocity
    client.onPacket(0x3e, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        entity.vx = packet.readInt16()
        entity.vy = packet.readInt16()
        entity.vz = packet.readInt16()
    })

    // TODO: 0x3f entity equipment

    // set experience
    client.onPacket(0x40, packet => xp = packet)

    // update health
    client.onPacket(0x41, packet => health = packet)

    // TODO: 0x42 scoreboard objective

    // set passengers
    client.onPacket(0x43, packet => {
        const eid_ = packet.readVarInt()
        const entity = entities.get(eid_)
        if (!entity) return
        if (riding == eid_) riding = null
        entity.passengers = [...Array(packet.readVarInt())].map(() => {
            const passengerEid = packet.readVarInt()
            if (passengerEid == eid) riding = eid
            return passengerEid
        })
    })

    // teams
    client.onPacket(0x44, packet => {
        const name = packet.readString()
        const mode = packet.readInt8()
        if (mode == 0 || mode == 2) {
            const displayName = packet.readString()
            const prefix = packet.readString(), suffix = packet.readString()
            const flags = packet.readUInt8(), nameTagVisibility = packet.readString()
            const collisionRule = packet.readString(), color = packet.readInt8()
            if (mode == 0) {
                teams.set(name, {
                    displayName, prefix, suffix, flags, nameTagVisibility, collisionRule, color,
                    members: new Set([...Array(packet.readVarInt())].map(() => packet.readString()))
                })
            } else {
                const team = teams.get(name)
                if (team) teams.set(name, {
                    ...team, displayName, prefix, suffix, flags, nameTagVisibility, collisionRule, color
                })
            }
        } else if (mode == 1) {
            teams.delete(name)
        } else if (mode == 3) {
            const team = teams.get(name)
            if (!team) return
            for (let i = packet.readVarInt(); i--;) team.members.add(packet.readString())
        } else if (mode == 4) {
            const team = teams.get(name)
            if (!team) return
            for (let i = packet.readVarInt(); i--;) team.members.delete(packet.readString())
        }
    })

    // TODO: 0x45 update score

    // spawn position
    client.onPacket(0x46, packet => spawn = packet)

    // time update
    client.onPacket(0x47, packet => time = packet)

    // TODO: 0x48 title

    // player list header and footer
    client.onPacket(0x4a, packet => tab = packet)

    // entity teleport
    client.onPacket(0x4c, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        entity.x = packet.readDouble()
        entity.y = packet.readDouble()
        entity.z = packet.readDouble()
        entity.yaw = packet.readInt8()
        entity.pitch = packet.readInt8()
    })

    // TODO: 0x4d advancements

    // entity properties
    client.onPacket(0x4e, packet => {
        const entity = entities.get(packet.readVarInt())
        if (!entity) return
        if (!entity.properties) entity.properties = new Map()
        for (let i = packet.readUInt32(); i--;) {
            const key = packet.readString()
            const start = packet.offset
            packet.offset += 8
            for (let j = packet.readVarInt(); j--;) packet.offset += 25
            entity.properties.set(key, packet.buffer.slice(start, packet.offset))
        }
    })

    // TODO: 0x4f entity effect

    function getPackets(isNew = false) {
        const packets: Packet[] = []
        let packet: PacketWriter

        if (isNew) {
            // join game
            packets.push(new PacketWriter(0x23).writeInt32(eid)
                .writeUInt8(gamemode).writeInt32(dimension).writeUInt8(difficulty)
                .writeUInt8(0).writeString(levelType).writeBool(false))
        } else {
            // respawn
            packets.push(new PacketWriter(0x35).writeInt32(dimension)
                .writeUInt8(difficulty).writeUInt8(gamemode & 0x7).writeString(levelType))
        }

        // player position and look
        packets.push(new PacketWriter(0x2f)
            .writeDouble(player.x).writeDouble(player.y).writeDouble(player.z)
            .writeFloat(player.yaw).writeFloat(player.pitch).writeUInt8(0)
            .writeVarInt(0))

        // chunk data
        for (const m of chunks.values()) {
            for (const chunk of m.values()) {
                packets.push(...chunk)
            }
        }

        // player list item
        packet = new PacketWriter(0x2e).writeVarInt(0).writeVarInt(players.size)
        for (const [uuid, player] of players.entries()) {
            packet.write(Buffer.from(uuid, "hex"))
            packet.writeString(player.name).writeVarInt(player.properties.length)
            for (const { name, value, signature } of player.properties) {
                packet.writeString(name).writeString(value)
                packet.writeBool(signature != null)
                if (signature != null) packet.writeString(signature)
            }
            packet.writeVarInt(player.gamemode).writeVarInt(player.ping)
            packet.writeBool(player.displayName != null)
            if (player.displayName != null) packet.writeString(player.displayName)
        }
        packets.push(packet)

        // teams
        for (const [name, team] of teams) {
            packet = new PacketWriter(0x44).writeString(name).writeInt8(0)
                .writeString(team.displayName)
                .writeString(team.prefix).writeString(team.suffix)
                .writeUInt8(team.flags).writeString(team.nameTagVisibility)
                .writeString(team.collisionRule).writeInt8(team.color)
            packet.writeVarInt(team.members.size)
            for (const member of team.members) packet.writeString(member)
            packets.push(packet)
        }

        // window items
        packet = new PacketWriter(0x14).writeUInt8(0).writeInt16(46)
        for (let i = 0; i < 46; i++) {
            const slot = inventory.get(i)
            if (slot) {
                packet.writeInt16(slot.id).writeInt8(slot.count).writeInt16(slot.damage)
                packet.write(nbt.encode("", slot.tag))
            } else {
                packet.writeInt16(-1)
            }
        }
        packets.push(packet)

        if (heldItem != 0) packets.push(new PacketWriter(0x3a).writeInt8(heldItem))
        if (playerAbilities) packets.push(playerAbilities)
        if (health) packets.push(health)
        if (xp) packets.push(xp)
        if (tab) packets.push(tab)
        if (time) packets.push(time)
        if (spawn) packets.push(spawn)

        if (raining) packets.push(new PacketWriter(0x1e).writeUInt8(2).writeFloat(0))
        if (fadeValue != 0) packets.push(new PacketWriter(0x1e).writeUInt8(7).writeFloat(fadeValue))
        if (fadeTime != 0) packets.push(new PacketWriter(0x1e).writeUInt8(7).writeFloat(fadeTime))

        for (const [eid, entity] of entities) {
            const spawn = entity.spawn.clone()

            if (entity.type == "object") {
                packets.push(new PacketWriter(0x0)
                    .writeVarInt(spawn.readVarInt())
                    .write(spawn.read(17))
                    .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
                    .writeInt8(entity.yaw!).writeInt8(entity.pitch!)
                    .writeInt32((spawn.read(26), spawn.readInt32()))
                    .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!))
            } else if (entity.type == "orb") {
                packets.push(new PacketWriter(0x1).writeVarInt(spawn.readVarInt())
                    .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
                    .writeInt16((spawn.read(24), spawn.readUInt16())))
            } else if (entity.type == "mob") {
                packet = new PacketWriter(0x3)
                    .writeVarInt(spawn.readVarInt())
                    .write(spawn.read(16))
                    .writeVarInt(spawn.readVarInt())
                    .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
                    .writeInt8(entity.yaw!).writeInt8(entity.pitch!).writeInt8(entity.headPitch!)
                    .writeInt16(entity.vx!).writeInt16(entity.vy!).writeInt16(entity.vz!)
                for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
                packets.push(packet.writeUInt8(0xff))
            } else if (entity.type == "player") {
                packet = new PacketWriter(0x5)
                    .writeVarInt(spawn.readVarInt())
                    .write(spawn.read(16))
                    .writeDouble(entity.x!).writeDouble(entity.y!).writeDouble(entity.z!)
                    .writeInt8(entity.yaw!).writeInt8(entity.pitch!)
                for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
                packets.push(packet.writeUInt8(0xff))
            } else {
                packets.push(spawn)
            }

            if (entity.metadata && entity.type != "mob" && entity.type != "player") {
                packet = new PacketWriter(0x3c).writeVarInt(eid)
                for (const [index, buffer] of entity.metadata!) packet.writeUInt8(index).write(buffer)
                packets.push(packet.writeUInt8(0xff))
            }

            if (entity.properties) {
                packet = new PacketWriter(0x4e).writeVarInt(eid).writeUInt32(entity.properties.size)
                for (const [key, buffer] of entity.properties) packet.writeString(key).write(buffer)
                packets.push(packet)
            }
        }

        for (const [eid, entity] of entities) if (entity.passengers) {
            packet = new PacketWriter(0x43).writeVarInt(eid).writeVarInt(entity.passengers.length)
            for (const eid of entity.passengers) packet.writeVarInt(eid)
            packets.push(packet)
        }

        for (const [id, map] of maps) {
            packet = new PacketWriter(0x24).writeVarInt(id).writeUInt8(map.scale)
            packet.writeBool(map.showIcons).writeVarInt(map.icons.length)
            for (const buf of map.icons) packet.write(buf)
            packet.writeUInt8(128).writeUInt8(128).writeUInt8(0).writeUInt8(0)
            packet.writeVarInt(16384).write(Buffer.from(map.data))
            packets.push(packet)
        }

        return packets.map(packet => new PacketReader(packet instanceof PacketWriter
            ? packet.encode() : packet instanceof Buffer ? packet : packet.buffer))
    }

    function mapClientboundPacket(packet: PacketReader, clientEid: number) {
        packet = packet.clone()
        if ([0x6, 0x8, 0x26, 0x27, 0x28, 0x30, 0x33, 0x36, 0x3e, 0x3f, 0x4c, 0x4e, 0x4f].includes(packet.id)) {
            // entity and player related packets
            const eid_ = packet.readVarInt()
            return new PacketWriter(packet.id).writeVarInt(eid_ == eid ? clientEid : eid_)
                .write(packet.buffer.slice(packet.offset))
        } else if (packet.id == 0x3c) {
            // entity metadata
            const eid_ = packet.readVarInt()
            const writer = new PacketWriter(packet.id)
                .writeVarInt(eid_ == eid ? clientEid : eid_)
            const objectType = objects.get(eid)
            if (objectType == 76) while (true) {
                const index = packet.readUInt8()
                writer.writeUInt8(index)
                if (index == 0xff) break
                const type = packet.readVarInt()
                writer.writeVarInt(type)
                const start = packet.offset
                if (objectType == 76 && index == 7 && type == 1) {
                    // entity which has used fireworks
                    const eid = packet.readVarInt()
                    writer.writeVarInt(eid_ == eid ? clientEid : eid_)
                    break
                }
                switch (type) {
                    case 0: case 6: packet.offset += 1; break
                    case 1: case 10: case 12: packet.readVarInt(); break
                    case 2: packet.offset += 4; break
                    case 3: case 4: packet.readString(); break
                    case 5: if (packet.readInt16() != -1) {
                        packet.offset += nbt.decode(packet.buffer.slice(packet.offset + 3)).length
                    }; break
                    case 7: packet.offset += 12; break
                    case 8: packet.offset += 8; break
                    case 9: if (packet.readBool()) packet.offset += 8; break
                    case 11: if (packet.readBool()) packet.offset += 16; break
                    case 13: packet.offset += nbt.decode(packet.buffer.slice(packet.offset)).length; break
                }
                writer.write(packet.buffer.slice(start, packet.offset))
            }

            return writer.write(packet.buffer.slice(packet.offset))
        } else if (packet.id == 0x1b) {
            // entity status
            const eid_ = packet.readInt32()
            return new PacketWriter(packet.id).writeInt32(eid_ == eid ? clientEid : eid_).writeUInt8(packet.readUInt8())
        } else if (packet.id == 0x43) {
            // set passengers
            const vehicle = packet.readVarInt(), count = packet.readVarInt()
            const writer = new PacketWriter(0x43).writeVarInt(vehicle).writeVarInt(count)
            for (let i = 0; i < count; i++) {
                const eid_ = packet.readVarInt()
                writer.writeVarInt(eid_ == eid ? clientEid : eid_)
            }
            return writer
        }

        return packet
    }

    function mapServerboundPacket(packet: PacketReader, clientEid: number) {
        packet = packet.clone()
        if (packet.id == 0xd || packet.id == 0xe) {
            // player position and look
            player.x = packet.readDouble()
            player.y = packet.readDouble()
            player.z = packet.readDouble()
            if (packet.id == 0xe) {
                player.yaw = packet.readFloat()
                player.pitch = packet.readFloat()
            }
        } else if (packet.id == 0xf) {
            // player look
            player.yaw = packet.readFloat()
            player.pitch = packet.readFloat()
        } else if (packet.id == 0x10) {
            // vehicle move
            const x = packet.readDouble(), y = packet.readDouble(), z = packet.readDouble()
            const entity = entities.get(riding!)
            if (entity) entity.x = x, entity.y = y, entity.z = z
            player.x = x, player.y = y, player.z = z
        } else if (packet.id == 0x15) {
            // entity action
            const eid_ = packet.readVarInt(), action = packet.readVarInt()
            return new PacketWriter(0x15).writeVarInt(eid_ == clientEid ? eid : eid_)
                .writeVarInt(action).writeVarInt(packet.readVarInt())
        } else if (packet.id == 0x1a) {
            // held item change
            heldItem = packet.readInt16()
        }

        return packet
    }

    async function connect(conn: ServerConnection, clientEid?: number) {
        if (!clientEid) clientEid = eid
        if (!client.socket.writable) throw new Error("Proxy not connected")

        conn.send(new PacketWriter(0x2).writeString(uuid).writeString(username))
        await new Promise(resolve => setTimeout(resolve, 100))

        for (const packet of getPackets(!!clientEid)) {
            await conn.send(mapClientboundPacket(packet, clientEid))
        }

        conn.on("packet", packet => {
            if (packet.id == 0x0 || packet.id == 0xb) return
            client.send(mapServerboundPacket(packet, clientEid!))
        })
        const packetListener = client.on("packet", packet => conn.send(mapClientboundPacket(packet, clientEid!)))
        const endListener = client.on("end", () => conn.end())

        conn.on("end", () => {
            packetListener.dispose()
            endListener.dispose()
        })
    }

    return {
        connect,
        getPackets,
        mapClientboundPacket,
        mapServerboundPacket
    }
}
