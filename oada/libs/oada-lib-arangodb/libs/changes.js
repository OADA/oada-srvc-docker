'use strict';

const { aql } = require('arangojs');
const pointer = require('json-pointer');
const debug = require('debug');

const db = require('../db');
const config = require('../config');

const trace = debug('arangodb#resources:trace');

const changes = db.collection(config.get('arangodb:collections:changes:name'));
const changeEdges = db.collection(
  config.get('arangodb:collections:changeEdges:name')
);

const MAX_DEPTH = 100;

function getChanges(resourceId, _changeRev) {
  return db
    .query(
      aql`
    FOR change in ${changes}
      FILTER change.resource_id == ${resourceId}
      RETURN change.number
  `
    )
    .call('all')
    .then((result) => {
      if (!result) {
        return undefined;
      }
      return result;
    });
}

function getMaxChangeRev(resourceId) {
  return db
    .query(
      aql`
        RETURN FIRST(
          FOR change in ${changes}
            FILTER change.resource_id == ${resourceId}
            SORT change.number DESC
            LIMIT 1
            RETURN change.number
        )`
    )
    .call('next')
    .then((result) => {
      if (!result) return 0;
      return result;
    });
}

// Produces a bare tree has a top level key at resourceId and traces down to the
// actual change that induced this rev update
// TODO: using .body allows the changes to be nested, but doesn't allow us to
// specify all of the other change details along the way down.
function getChange(resourceId, changeRev) {
  //TODO: This is meant to handle when resources are deleted directly. Edge
  // cases remain to be tested. Does this suffice regarding the need send down a
  // bare tree?
  if (!changeRev) {
    return Promise.resolve({
      body: null,
      type: 'delete',
    });
  }

  return db
    .query(
      aql`
    LET change = FIRST(
      FOR change in ${changes}
      FILTER change.resource_id == ${resourceId}
      FILTER change.number == ${parseInt(changeRev, 10)}
      RETURN change
    )
    LET path = LAST(
      FOR v, e, p IN 0..${MAX_DEPTH} OUTBOUND change ${changeEdges}
      RETURN p
    )
    RETURN path

  `
    )
    .call('next')
    .then((result) => {
      if (!result || !result.vertices[0]) {
        return undefined;
      }
      let change = {
        body: result.vertices[0].body,
        type: result.vertices[0].type,
        wasDelete:
          result.vertices[result.vertices.length - 1].type === 'delete',
      };
      let path = '';
      for (let i = 0; i < result.vertices.length - 1; i++) {
        path += result.edges[i].path;
        pointer.set(change.body, path, result.vertices[i + 1].body);
      }
      return change;
    });
}

// Produces a list of changes as an array
function getChangeArray(resourceId, changeRev) {
  //TODO: This is meant to handle when resources are deleted directly. Edge
  // cases remain to be tested. Does this suffice regarding the need send down a
  // bare tree?
  if (!changeRev) {
    return Promise.resolve([
      {
        resource_id: resourceId,
        path: '',
        body: null,
        type: 'delete',
      },
    ]);
  }

  return db
    .query(
      aql`
    LET change = FIRST(
      FOR change in ${changes}
      FILTER change.resource_id == ${resourceId}
      FILTER change.number == ${parseInt(changeRev, 10)}
      RETURN change
    )
    FOR v, e, p IN 0..${MAX_DEPTH} OUTBOUND change ${changeEdges}
      SORT LENGTH(p.edges), v.number
      RETURN p`
    )
    .then(async (cursor) => {
      // iterate over the graph
      return cursor.map((doc) => toChangeObj(doc)); // convert to change object
    });
}

function toChangeObj(arangoPathObj) {
  // get path
  let path = '';
  for (let j = 0; j < arangoPathObj.edges.length; j++) {
    path += arangoPathObj.edges[j].path;
  }
  // get body
  const nVertices = arangoPathObj.vertices.length;
  let body = arangoPathObj.vertices[nVertices - 1].body;
  let resource_id = arangoPathObj.vertices[nVertices - 1].resource_id;
  // return change object
  trace('toChangeObj: returning change object with body %O', body);
  return {
    resource_id,
    path,
    body,
    type: arangoPathObj.vertices[nVertices - 1].type,
  };
}

function getRootChange(resourceId, changeRev) {
  return db
    .query(
      aql`
    LET change = FIRST(
      FOR change in ${changes}
      FILTER change.resource_id == ${resourceId}
      FILTER change.number == ${parseInt(changeRev, 10)}
      RETURN change
    )
    LET path = LAST(
      FOR v, e, p IN 0..${MAX_DEPTH} OUTBOUND change ${changeEdges}
      RETURN v
    )
    RETURN path
  `
    )
    .call('next');
}

function putChange({
  change,
  resId,
  rev,
  type,
  children,
  path,
  userId,
  authorizationId,
}) {
  if (!Array.isArray(children)) {
    throw new Error('children must be an array.');
  }
  let number = parseInt(rev, 10);
  trace('putChange: inserting change with body %O', change);
  return db
    .query(
      aql`
    LET doc = FIRST(
      INSERT {
        body: ${change},
        type: ${type},
        resource_id: ${resId},
        number: ${number},
        authorization_id: ${authorizationId || null},
        user_id: ${userId || null}
      } IN ${changes}
      RETURN NEW
    )

    LET children = (
      FOR child IN ${children}
        INSERT {
          _to: child,
          _from: doc._id,
          path: ${path || null}
        } in ${changeEdges}
    )
    RETURN doc._id
  `
    )
    .call('next');
}

module.exports = {
  getChange,
  getChangeArray,
  getRootChange,
  getChanges,
  getMaxChangeRev,
  putChange,
};
