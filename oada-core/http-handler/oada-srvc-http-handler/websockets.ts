import { resolve } from 'path'
import { strict as _assert } from 'assert'

import debug from 'debug'

import * as jsonpointer from 'jsonpointer'
import Ajv from 'ajv'

import { OADAError } from 'oada-error'

import * as WebSocket from 'ws'
// prettier-ignore
import type { Server } from 'http'
import axios, { AxiosRequestConfig } from 'axios'

import * as TJS from 'typescript-json-schema'

import { EventEmitter } from 'events'
import { Responder, KafkaReguest } from '../../libs/oada-lib-kafka'
import { resources, changes, Change } from '../../libs/oada-lib-arangodb'
import config from './config'
const revLimit = 10

const info = debug('websockets:info')
const trace = debug('websockets:trace')
const error = debug('websockets:error')

const emitter = new EventEmitter()

// Make sure we stringify the http request data ourselves
type RequestData = string & { __reqData__: void }
interface HTTPRequest extends AxiosRequestConfig {
    data?: RequestData
}
function serializeRequestData (data: any): RequestData {
    return JSON.stringify(data) as RequestData
}

/**
 * Call node's strict assert function
 * @todo Fix declaration rather than wrapping in new function?
 */
function assert (value: any, message?: string | Error): asserts value {
    return _assert(value, message)
}

// Add our state to the websocket type?
interface Socket extends WebSocket {
    isAlive?: boolean
}

export type SocketRequest = {
    requestId: string | string[]
    path: string
    method: 'head' | 'get' | 'put' | 'post' | 'delete' | 'watch' | 'unwatch'
    headers: { authorization: string } & { [key: string]: string }
    data?: any
}

export type SocketResponse = {
    requestId: string | string[]
    /**
     * @todo Why is this weird?
     */
    status: 'success' | number
    // TODO: Figure out this mess of responses...
    statusText?: string
    headers?: { [key: string]: string }
    resourceId?: string
    resource?: any
    data?: any
}

export type SocketChange = {
    requestId: string | string[]
    resourceId: string
    path_leftover: string
    change: any // TODO: Change type?
}

/**
 * Check incoming requests against schema since they are coming over network
 *
 * This way the rest of the code can assume the format is correct
 */
const ajv = new Ajv()
const program = TJS.programFromConfig(resolve('./tsconfig.json'))
// Precompile schema validator
const requestValidator = ajv.compile(
    TJS.generateSchema(program, 'SocketRequest') as object
)
function parseRequest (data: WebSocket.Data): SocketRequest {
    function assertRequest (value: any): asserts value is SocketRequest {
        if (!requestValidator(value)) {
            throw requestValidator.errors
        }
    }

    assert(typeof data === 'string')
    const msg = JSON.parse(data)

    // Normalize method capitalization
    msg.method = msg?.method?.toLowerCase()
    // Normalize header name capitalization
    const headers = msg?.headers ?? {}
    msg.headers = {}
    for (const header in headers) {
        msg.headers[header.toLowerCase()] = headers[header]
    }

    // Assert type schema
    assertRequest(msg)

    return msg
}

module.exports = function wsHandler (server: Server) {
    const wss = new WebSocket.Server({ server })

    // Add socket to storage
    wss.on('connection', function connection (socket: Socket) {
        socket.isAlive = true
        socket.on('pong', function heartbeat () {
            socket.isAlive = true
        })

        function sendResponse (resp: SocketResponse) {
            socket.send(JSON.stringify(resp))
        }
        function sendChange (resp: SocketChange) {
            socket.send(JSON.stringify(resp))
        }

        // Handle request
        socket.on('message', async function message (data) {
            let msg: SocketRequest
            try {
                msg = parseRequest(data)
            } catch (e) {
                const err = {
                    status: 400,
                    requestId: [],
                    headers: {},
                    data: new OADAError(
                        'Bad Request',
                        400,
                        'Invalid socket message format',
                        null,
                        e
                    )
                }
                sendResponse(err)
                error(e)
                return
            }

            try {
                await handleRequest(msg)
            } catch (e) {
                error(e)
                const err = {
                    status: 500,
                    requestId: msg.requestId,
                    headers: {},
                    data: new OADAError('Internal Error', 500)
                }
                sendResponse(err)
            }
        })

        async function handleRequest (msg: SocketRequest) {
            info(`Handling socket req ${msg.requestId}:`, msg.method, msg.path)

            const request: HTTPRequest = {
                baseURL: 'http://127.0.0.1',
                url: msg.path,
                headers: msg.headers
            }
            switch (msg.method) {
                case 'unwatch':
                    trace('UNWATCH')
                case 'watch':
                    request.method = 'head'
                    break

                case 'put':
                case 'post':
                    request.data = serializeRequestData(msg.data)
                default:
                    request.method = msg.method
                    break
            }
            try {
                const res = await axios.request<any>(request)
                const parts = res.headers['content-location'].split('/')
                let resourceId: string
                let path_leftover = ''
                assert(parts.length >= 3)
                resourceId = `${parts[1]}/${parts[2]}`
                if (parts.length > 3) path_leftover = parts.slice(3).join('/')
                if (path_leftover) {
                    path_leftover = `/${path_leftover}`
                }

                function handleChange ({ change }: { change: Change }) {
                    // let c = change.change.merge || change.change.delete;
                    trace('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')
                    trace('responding watch', resourceId)
                    trace('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~')

                    const pathChange = jsonpointer.get(
                        change?.body ?? {},
                        path_leftover
                    )
                    if (pathChange === undefined) {
                        // No change to report
                        return
                    }

                    sendChange({
                        requestId: msg.requestId,
                        resourceId,
                        path_leftover,
                        change
                    })
                }

                switch (msg.method) {
                    case 'delete':
                        if (parts.length === 3) {
                            // it is a resource
                            emitter.removeAllListeners(resourceId)
                        }
                        break

                    case 'unwatch':
                        trace('closing watch', resourceId)
                        emitter.removeListener(resourceId, handleChange)

                        sendResponse({
                            requestId: msg.requestId,
                            status: 'success'
                        })
                        break
                    case 'watch':
                        trace('opening watch', resourceId)
                        emitter.on(resourceId, handleChange)

                        socket.on('close', function handleClose () {
                            emitter.removeListener(resourceId, handleChange)
                        })

                        // Emit all new changes from the given rev in the request
                        if (request.headers['x-oada-rev']) {
                            trace('Setting up watch on:', resourceId)
                            trace(
                                'RECEIVED THIS REV:',
                                resourceId,
                                request.headers['x-oada-rev']
                            )
                            const rev = await resources.getResource(
                                resourceId,
                                '_rev'
                            )
                            // If the requested rev is behind by revLimit, simply
                            // re-GET the entire resource
                            trace(
                                'REVS:',
                                resourceId,
                                rev,
                                request.headers['x-oada-rev']
                            )
                            if (
                                parseInt(rev) -
                                    parseInt(request.headers['x-oada-rev']) >=
                                revLimit
                            ) {
                                trace(
                                    'REV WAY OUT OF DATE',
                                    resourceId,
                                    rev,
                                    request.headers['x-oada-rev']
                                )
                                const resource = await resources.getResource(
                                    resourceId
                                )
                                sendResponse({
                                    requestId: msg.requestId,
                                    resourceId,
                                    resource,
                                    status: 'success'
                                })
                            } else {
                                // First, declare success.
                                sendResponse({
                                    requestId: msg.requestId,
                                    status: 'success'
                                })
                                trace(
                                    'REV NOT TOO OLD...',
                                    resourceId,
                                    rev,
                                    request.headers['x-oada-rev']
                                )
                                // Next, feed changes to client
                                const newChanges = await changes.getChangesSinceRev(
                                    resourceId,
                                    request.headers['x-oada-rev']
                                )
                                newChanges.forEach(change =>
                                    sendChange({
                                        requestId: msg.requestId,
                                        resourceId,
                                        path_leftover,
                                        change
                                    })
                                )
                            }
                        } else {
                            sendResponse({
                                requestId: msg.requestId,
                                status: 'success'
                            })
                        }
                        break
                    default:
                        sendResponse({
                            requestId: msg.requestId,
                            status: res.status,
                            headers: res.headers,
                            data: res.data
                        })
                }
            } catch (err) {
                if (err.response) {
                    const e = {
                        requestId: msg.requestId,
                        status: err.response.status,
                        statusText: err.response.statusText,
                        headers: err.response.headers,
                        data: err.response.data
                    }
                    return sendResponse(e)
                } else {
                    throw err
                }
            }
        }
    })

    const interval = setInterval(function ping () {
        wss.clients.forEach(function each (sock) {
            const socket = sock as Socket // TODO: Better way to do this?
            if (socket.isAlive === false) {
                return socket.terminate()
            }

            socket.isAlive = false
            socket.ping()
        })
    }, 30000)

    wss.on('close', function close () {
        clearInterval(interval)
    })
}

const writeResponder = new Responder(
    config.get('kafka:topics:httpResponse'),
    null,
    'websockets'
)

type WriteResponse = {
    msgtype: 'write-response'
    code: 'success'
    resource_id: string
    path_leftover: string
    _rev: number
}
function checkReq (req: KafkaReguest): req is WriteResponse {
    return req.msgtype === 'write-response' && req.code === 'success'
}
// Listen for successful write requests to resources of interest, then emit an event
writeResponder.on('request', async function handleReq (req) {
    if (!checkReq(req)) {
        return
    }

    trace('@@@@@@@@@@@@@@@', req.resource_id)
    try {
        const change = await changes.getChange(req.resource_id, req._rev)
        trace('Emitted change for:', req.resource_id, change)
        emitter.emit(req.resource_id, {
            path_leftover: req.path_leftover,
            change
        })
        if (change && change.type === 'delete') {
            trace(
                'Delete change received for:',
                req.resource_id,
                req.path_leftover,
                change
            )
            if (req.resource_id && req.path_leftover === '') {
                trace('Removing all listeners to:', req.resource_id)
                emitter.removeAllListeners(req.resource_id)
            }
        }
    } catch (e) {
        error(e)
    }
})
