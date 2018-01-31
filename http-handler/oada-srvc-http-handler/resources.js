'use strict';

var Promise = require('bluebird');
const uuid = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const pointer = require('json-pointer');
const _ = require('lodash');

const info = require('debug')('http-handler:info');
const warn = require('debug')('http-handler:warn');
//const error = require('debug')('http-handler:error');
const trace = require('debug')('http-handler:trace');

const resources = require('../../libs/oada-lib-arangodb').resources;
const putBodies = require('../../libs/oada-lib-arangodb').putBodies;
const OADAError = require('oada-error').OADAError;

const config = require('./config');

var requester = require('./requester');

var router = express.Router();
var expressWs = require('express-ws')(router);

// Turn POSTs into PUTs at random id
router.post('/*?', function postResource(req, res, next) {
    // TODO: Is this a good way to generate new id?
    if (req.url === '' || req.url.endsWith('/')) {
        req.url += uuid();
    } else {
        req.url += '/' + uuid();
    }
    req.method = 'PUT';

    next();
});

router.use(function graphHandler(req, res, next) {
    return requester.send({
        'connection_id': req.id,
        'domain': req.get('host'),
        'token': req.get('authorization'),
        'url': '/resources' + req.url,
        'user_id': req.user.doc.user_id
    }, config.get('kafka:topics:graphRequest'))
    .then(function handleGraphRes(resp) {
        if (resp['resource_id']) {
            // Rewire URL to resource found by graph
            let url = `${resp['resource_id']}${resp['path_leftover']}`;
            // Remove "/resources" from id
            req.url = url.replace(/^\/?resources\//, '/');
        }
        res.set('Content-Location', req.baseUrl + req.url);
        // TODO: Just use express parameters rather than graph thing?
        req.oadaGraph = resp;
    })
    .asCallback(next);
});

router.put('/*', function checkScope(req, res, next) {
    requester.send({
        'connection_id': req.id,
        'domain': req.get('host'),
        'oadaGraph': req.oadaGraph,
        'user_id': req.user.doc['user_id'],
        'scope': req.user.doc.scope,
        'contentType': req.get('Content-Type'),
    }, config.get('kafka:topics:permissionsRequest'))
    .then(function handlePermissionsRequest(response) {
        if (!req.oadaGraph['resource_id']) { // PUTing non-existant resource
            return;
        } else if (!response.permissions.owner && !response.permissions.write) {
                warn(req.user.doc['user_id'] +
                    ' tried to GET resource without proper permissions');
            throw new OADAError('Not Authorized', 403,
                    'User does not have write permission for this resource');
        }
        if (!response.scopes.write) {
            throw new OADAError('Not Authorized', 403,
                    'Token does not have required scope');
        }
    }).asCallback(next);
});

router.get('/*', function checkScope(req, res, next) {
    requester.send({
        'connection_id': req.id,
        'domain': req.get('host'),
        'oadaGraph': req.oadaGraph,
        'user_id': req.user.doc['user_id'],
        'scope': req.user.doc.scope,
    }, config.get('kafka:topics:permissionsRequest'))
    .then(function handlePermissionsRequest(response) {
        trace('permissions response:' + response);
        if (!response.permissions.owner && !response.permissions.read) {
            warn(req.user.doc['user_id'] +
                    ' tried to GET resource without proper permissions');
            throw new OADAError('Not Authorized', 403,
                    'User does not have read permission for this resource');
        }

        if (!response.scopes.read) {
            throw new OADAError('Not Authorized', 403,
                    'Token does not have required scope');
        }
    }).asCallback(next);
});

router.get('/*', function getResource(req, res, next) {
    // TODO: Should it not get the whole meta document?
    // TODO: Make getResource accept an array of paths and return an array of
    //       results. I think we can do that in one arango query

    var doc = resources.getResource(
            req.oadaGraph['resource_id'],
            req.oadaGraph['path_leftover']
    );

    return Promise
        .join(doc, function returnDoc(doc) {
            // TODO: Allow null values in OADA?
            if (doc === undefined || doc === null) {
                throw new OADAError('Not Found', 404);
            }

            doc = unflattenMeta(doc);
            info('doc unflattened now');
            return res.json(doc);
        })
        .catch(next);
});

// TODO: This was a quick make it work. Do what you want with it.
function unflattenMeta(doc) {
    if (doc === null) {
        // Object.keys does not like null
        return null;
    }
    if (doc._meta) {
        doc._meta = {
            _id: doc._meta._id,
            _rev: doc._meta._rev,
        };
    }
    if (doc._changes) {
        doc._changes = {
            _id: doc._changes._id,
            _rev: doc._changes._rev,
        };
    }/*
    Object.keys(doc).forEach((key) => {
        if (doc[key]._id) {
            if (doc[key]['_oada_rev']) {
                doc[key] = {
                    '_id': doc[key]._id,
                    '_rev': doc[key]['_oada_rev']
                };
            } else {
                doc[key] = {_id: doc[key]._id};
            }
        } else {
            if (typeof doc[key] === 'object') {
                doc[key] = unflattenMeta(doc[key]);
            }
        }
    });
    */
    return doc;
}

// Don't let users modify their shares?
function noModifyShares(req, res, next) {
    let err = null;

    if (req.url.match(`^/${req.user.doc['shares_id']}`)) {
        err = new OADAError('Forbidden', 403,
            'User cannot modify their shares document');
    }

    next(err);
}
router.delete('/*', noModifyShares);
router.put('/*', noModifyShares);

// Parse JSON content types as text (but do not parse JSON yet)
router.put('/*', bodyParser.text({
    strict: false,
    type: ['json', '+json'],
    limit: '20mb',
}));
router.put('/*', function checkBodyParsed(req, res, next) {
    let err = null;

    // TODO: Better way to decide if body was parsed?
    if (typeof req.body !== 'string') {
        // Body hasn't been parsed, assume it was bad
        err = new OADAError('Unsupported Media Type', 415);
    }

    return next(err);
});

function replaceLinks(desc) {
    let ret = (Array.isArray(desc)) ? [] : {};
    if (!desc) return desc;  // no defined descriptors for this level
    Object.keys(desc).forEach(function(key, idx) {
        if (key === '*') { // Don't put *s into oada. Ignore them
			return;
		}
		let val = desc[key];
        if (typeof val !== 'object' || !val) {
            ret[key] = val; // keep it asntType: 'application/vnd.oada.harvest.1+json'
            return;
		}
        if (val._type) { // If it has a '_type' key, don't worry about it.
            //It'll get created in future iterations of ensureTreeExists
            return;
        }
		if (val._id) { // If it's an object, and has an '_id', make it a link from descriptor
            ret[key] = { _id: desc[key]._id, _rev: '0-0' };
            return;
        }
        ret[key] = replaceLinks(val); // otherwise, recurse into the object looking for more links
    });
    return ret;
}

let trees = {
    'as-harvested': {
        'harvest': {
            '_type': "application/vnd.oada.harvest.1+json",
            'as-harvested': {
                '_type': "application/vnd.oada.as-harvested.1+json",
                'yield-moisture-dataset': {
                    '_type': "application/vnd.oada.as-harvested.yield-moisture-dataset.1+json",
                    'crop-index': {
                        '*': {
                            '_type': "application/vnd.oada.as-harvested.yield-moisture-dataset.1+json",
                            'geohash-length-index': {
                                '*': {
                                    '_type': "application/vnd.oada.as-harvested.yield-moisture-dataset.1+json",
                                    'geohash-index': {
                                        '*': {
                                            '_type': "application/vnd.oada.as-harvested.yield-moisture-dataset.1+json",
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
        },
    },
    'tiled-maps': {
        'harvest': {
            'tiled-maps': {
                '_type': "application/vnd.oada.tiled-maps.1+json",
                'dry-yield-map': {
                    '_type': "application/vnd.oada.tiled-maps.dry-yield-map.1+json",
                    'crop-index': {
                        '*': {
                            "_type": "application/vnd.oada.tiled-maps.dry-yield-map.1+json",
                            'geohash-length-index': {
                                '*': {
                                    "_type": "application/vnd.oada.tiled-maps.dry-yield-map.1+json",
                                    'geohash-index': {
                                        '*': {
                                            "_type": "application/vnd.oada.tiled-maps.dry-yield-map.1+json",
                                            "datum": "WGS84",
                                            "geohash-data": {},
                                            "stats": {},
                                            "templates": {}
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

function getFromStarredTree(path, tree) {
    let pieces = pointer.parse(path);
    let subTree = tree;
    return Promise.each(pieces, (piece, i) => {
        let nextPath = pointer.compile(pieces.slice(0, i+1))
        // If a star is present in the tree, proceed
        if (nextPath && pointer.has(tree, nextPath+'/*')) {
            subTree = pointer.get(tree, nextPath+'/*')
        }
        return
    }).then(() => {
        return subTree
    })
}

router.put('/*', function ensureTreeExists(req, res, next) {
    if (req.headers['x-oada-bookmarks-type']) {
        let tree = trees[req.headers['x-oada-bookmarks-type']];// Get the tree

        //First, get the appropriate subTree rooted at the resource returned by
        //graph lookup
        //TODO: make this more robust. Currently, the second time this is run
        //after deleting between deep puts, it blows up.
        let path = req.url.split(req.oadaGraph.path_leftover)[0];
        trace('oadaGraph', req.url, req.oadaGraph)
        trace('prefix', path)
        return getFromStarredTree(path, tree).then((subTree) => {
            trace('returned subTree', subTree)

            // Find all resources in the subTree that haven't been created
            //let existsPieces = pointer.parse(req.oadaGraph.path_leftover_exists);
            //let notExistsPieces = pointer.parse(req.oadaGraph.path_leftover_not_exists);
            let pieces = pointer.parse(req.oadaGraph.path_leftover);
            trace('commencing creation of pieces', pieces)
            let piecesPath = '';
            let id = req.oadaGraph.resource_id.replace(/^\//, '');
            let parentId = req.oadaGraph.resource_id.replace(/^\//, '');
            let parentPath = ''
            return Promise.each(pieces, (piece, i) => {
                trace('subtree', subTree)
                trace('next piece', i, path+ '/' + piece)
                let nextPiece = pointer.has(subTree, '/'+piece) ? '/'+piece : undefined;
                nextPiece = pointer.has(subTree, '/*') ? '/*' : nextPiece;
                path += '/'+piece;
                piecesPath += nextPiece
                parentPath+= '/'+piece
                trace('path', path)
                trace('piecesPath', piecesPath)
                subTree = pointer.get(subTree, nextPiece)
                trace('subtreee now', subTree)
                if (nextPiece) {
                    if (pointer.has(subTree, '/_type')) {
                        let contentType = pointer.get(subTree, '/_type');
                        id = 'resources/'+uuid.v4();
                        let body = replaceLinks(_.cloneDeep(subTree))
                        // Write new resource. This may potentially become an
                        // orphan if concurrent requests make links below
                        trace('NEW RESOURCE', {
                            resource_id: '',
                            path_leftover: '/'+id,
                            user_id: req.user.doc.user_id,
                            contentType,
                            body
                        })
                        return requester.send({
                            resource_id: '',
                            path_leftover: '/'+id,
                            user_id: req.user.doc.user_id,
                            contentType,
                            body
                        }, config.get('kafka:topics:writeRequest')).then(() => {
                        // Write link from parent. These writes reference the
                        // path from the known resource returned by graph lookup
                            trace('PARENT LINK', {
                                resource_id: parentId,
                                path_leftover: parentPath,
                                user_id: req.user.doc.user_id,
                                contentType,
                                body: {_id: id, _rev: '0-0'}
                            })
                            return requester.send({
                                resource_id: parentId,
                                path_leftover: parentPath,
                                user_id: req.user.doc.user_id,
                                contentType,
                                body: {_id: id, _rev: '0-0'}
                            }, config.get('kafka:topics:writeRequest'));

                        }).catch((err) => {

                        }).then(() => {
                            parentId = id;
                            parentPath = '';
                            return
                        })
                    }
                }
                return
            }).then(() => {
                req.oadaGraph.resource_id = parentId;
                req.oadaGraph.path_leftover = parentPath;
            }).asCallback(next)
        })
    }
})

router.put('/*', function putResource(req, res, next) {
    info(`Saving PUT body for request ${req.id}`);
    return putBodies.savePutBody(req.body)
        .tap(() => info(`PUT body saved for request ${req.id}`))
        .get('_id')

        .then(bodyid => {
            return requester.send({
                'connection_id': req.id,
                'domain': req.get('host'),
                'url': req.url,
                'resource_id': req.oadaGraph['resource_id'],
                'path_leftover': req.oadaGraph['path_leftover'],
                'meta_id': req.oadaGraph['meta_id'],
                'user_id': req.user.doc['user_id'],
                'authorizationid': req.user.doc['authorizationid'],
                'client_id': req.user.doc['client_id'],
                'contentType': req.get('Content-Type'),
                'bodyid': bodyid,
                //body: req.body
            }, config.get('kafka:topics:writeRequest'));
        })
        .tap(function checkWrite(resp) {
            info(`Recieved write response for request ${req.id}`);
            switch (resp.code) {
                case 'success':
                    return;
                case 'permission':
                    return Promise.reject(new OADAError('Not Authorized', 403,
                            'User does not own this resource'));
                default:
                    let msg = 'write failed with code ' + resp.code;

                    return Promise.reject(new OADAError(msg));
            }
        })
        .then(function(resp) {
            return res
                .set('X-OADA-Rev', resp['_rev'])
                .redirect(204, req.baseUrl + req.url);
        })
        .catch(next);
});

// Don't let users DELETE their bookmarks?
router.delete('/*', function noDeleteBookmarks(req, res, next) {
    let err = null;

    if (req.url === '/' + req.user.doc['bookmarks_id']) {
        err = new OADAError('Forbidden', 403,
            'User cannot delete their bookmarks');
    }

    next(err);
});

router.delete('/*', function deleteLink(req, res, next) {
    // Check if followed a link and are at the root of the linked resource
    if (req.oadaGraph.from['path_leftover'] &&
            !req.oadaGraph['path_leftover']) {
        // Switch to DELETE on parent resource
        let id = req.oadaGraph.from['resource_id'];
        let path = req.oadaGraph.from['path_leftover'];
        req.url = '/' + id.replace(/^\/?resources\//, '') + path;
        req.oadaGraph = req.oadaGraph.from;
    }

    next();
});

router.delete('/*', function deleteResource(req, res, next) {
    info(`Sending DELETE request for request ${req.id}`);
    return requester.send({
        'connection_id': req.id,
        'domain': req.get('host'),
        'url': req.url,
        'resource_id': req.oadaGraph['resource_id'],
        'path_leftover': req.oadaGraph['path_leftover'],
        'meta_id': req.oadaGraph['meta_id'],
        'user_id': req.user.doc['user_id'],
        'authorizationid': req.user.doc['authorizationid'],
        'client_id': req.user.doc['client_id'],
        //'bodyid': bodyid, // No body means delete?
        //body: req.body
    }, config.get('kafka:topics:writeRequest'))
    .tap(function checkDelete(resp) {
        info(`Recieved delete response for request ${req.id}`);
        switch (resp.code) {
            case 'success':
                return;
            case 'not_found':
                // fall-through
                // TODO: Is 403 a good response for DELETE on non-existent?
            case 'permission':
                return Promise.reject(new OADAError('Not Authorized', 403,
                        'User does not own this resource'));
            default:
                let err = new OADAError('delete failed with code ' + resp.code);
                return Promise.reject(err);
        }
    })
    .then(function(resp) {
        return res
            .set('X-OADA-Rev', resp['_rev'])
            .sendStatus(204);
    })
    .catch(next);
});



module.exports = router;
