import { EventEmitter } from "events";
import { IncomingMessage } from "http";

export type MessageType = "request" | "publish";

export interface ChannelContext {
    type: MessageType
    id?: string
    method: string
    data: any
}

export type RouteHandler<Input = any, Output = any> =
    (data: Input, channel: Channel<any>, ctx: ChannelContext) =>
        Output | Promise<Output>

export type RouteMap = Record<string, RouteHandler<any, any>>

export type Middleware =
    <R extends RouteMap>(
        ctx: ChannelContext,
        next: () => Promise<any>,
        channel: Channel<R>
    ) => any | Promise<any>

export interface RequestOptions {
    timeout?: number
    signal?: AbortSignal
}

export interface ChannelOptions<R extends RouteMap = {}> {
    routes?: R
    middleware?: Middleware[]
    requestTimeout?: number
    serializer?: (message: any) =>
        string | Buffer | ArrayBuffer | ArrayBufferView
    deserializer?: (payload: string) => any
    maxPayload?: number
}

type RouteInput<T> =
    T extends (data: infer I, ...args: any[]) => any ? I : never

type RouteOutput<T> =
    T extends (...args: any[]) => infer O ? Awaited<O> : never

export class Channel<R extends RouteMap = {}> extends EventEmitter {

    constructor(ws: any, options?: ChannelOptions<R>)

    readonly isOnline: boolean
    readonly isClosed: boolean

    setRoute<K extends string, H extends RouteHandler>(
        method: K,
        handler: H
    ): this

    removeRoute(method: string): this

    use(fn: Middleware): this

    request<K extends keyof R>(
        method: K,
        data: RouteInput<R[K]>,
        options?: RequestOptions
    ): Promise<RouteOutput<R[K]>>

    publish<K extends keyof R>(
        method: K,
        data: RouteInput<R[K]>
    ): boolean

    close(code?: number, reason?: string): void
    terminate(): void
    destroy(): void

    on(event: "connected", listener: () => void): this
    on(event: "disconnected", listener: (code: number, reason: string) => void): this
    on(event: "error", listener: (err: Error) => void): this
    on(event: "protocolError", listener: (err: Error) => void): this
}

export interface ServerOptions<R extends RouteMap = {}> {
    port?: number
    host?: string
    externalServer?: any
    routes?: R
    middleware?: Middleware[]
    requestTimeout?: number
    serializer?: (message: any) =>
        string | Buffer | ArrayBuffer | ArrayBufferView
    deserializer?: (payload: string) => any
    maxPayload?: number
    perMessageDeflate?: boolean
    wsOptions?: Record<string, any>
}

export class Server<R extends RouteMap = {}> extends EventEmitter {

    constructor(options?: ServerOptions<R>)

    readonly channels: Set<Channel<R>>
    readonly started: boolean

    start(): Promise<void>
    stop(): Promise<void>

    broadcast<K extends keyof R>(
        method: K,
        data: RouteInput<R[K]>
    ): number

    on(
        event: "connection",
        listener: (channel: Channel<R>, req: IncomingMessage) => void
    ): this

    on(
        event: "clientError",
        listener: (err: Error, channel: Channel<R>, req: IncomingMessage) => void
    ): this

    on(
        event: "clientProtocolError",
        listener: (err: Error, channel: Channel<R>, req: IncomingMessage) => void
    ): this

    on(
        event: "listening",
        listener: (port: number, host?: string) => void
    ): this

    on(event: "error", listener: (err: Error) => void): this
}

export interface ClientOptions<R extends RouteMap = {}> {
    autoReconnect?: boolean
    reconnectInterval?: number
    pingInterval?: number
    requestTimeout?: number
    routes?: R
    middleware?: Middleware[]
    serializer?: (message: any) =>
        string | Buffer | ArrayBuffer | ArrayBufferView
    deserializer?: (payload: string) => any
    maxPayload?: number
    rejectUnauthorized?: boolean
    perMessageDeflate?: boolean
    wsOptions?: Record<string, any>
}

export class Client<R extends RouteMap = {}> extends EventEmitter {

    constructor(url: string, options?: ClientOptions<R>)

    channel: Channel<R> | null

    close(code?: number, reason?: string): void
    terminate(): void

    on(event: "connected", listener: (channel: Channel<R>) => void): this
    on(event: "disconnected", listener: (code?: number, reason?: string) => void): this
    on(event: "error", listener: (err: Error) => void): this
    on(event: "protocolError", listener: (err: Error) => void): this
}