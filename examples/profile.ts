import fetch from "node-fetch"

export interface Profile {
    id: string
    name: string
    accessToken: string
}

export async function update(profile?: Profile | null, username?: string, password?: string): Promise<Profile> {
    if (profile) {
        if (await validate(profile.accessToken)) return profile
        try {
            const res = await refresh(profile.accessToken)
            return { ...res.selectedProfile, accessToken: res.accessToken }
        } catch { }
    }

    if (username == null || password == null) {
        throw new Error("Could not authenticate without credentials")
    }

    const res = await authenticate(username, password)
    return { ...res.selectedProfile, accessToken: res.accessToken }
}

interface AuthResponse {
    accessToken: string
    selectedProfile: {
        id: string
        name: string
    }
}

async function authenticate(username: string, password: string): Promise<AuthResponse> {
    return await request("/authenticate", {
        agent: {
            name: "Minecraft",
            version: 1
        },
        username,
        password
    })
}

async function refresh(accessToken: string): Promise<AuthResponse> {
    return await request("/refresh", { accessToken })
}

async function validate(accessToken: string): Promise<boolean> {
    const res = await fetch("https://authserver.mojang.com/validate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ accessToken })
    })

    return res.ok
}

async function request(path: string, body: any) {
    const res = await fetch("https://authserver.mojang.com/" + path, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    })

    if (!res.ok) throw new Error(res.statusText)

    return await res.json()
}
