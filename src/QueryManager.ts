import {
  NetworkInterface,
  Request,
} from './networkInterface';

import {
  parseQuery,
  parseMutation,
} from './parser';

import {
  assign,
  forOwn,
} from 'lodash';

import {
  createQueryResultAction,
  Store,
} from './store';

import {
  Store as ReduxStore,
} from 'redux';

import {
  SelectionSet,
  GraphQLError,
  GraphQLResult,
  OperationDefinition,
} from 'graphql';

import {
  readSelectionSetFromStore,
} from './readFromStore';

import {
  diffSelectionSetAgainstStore,
} from './diffAgainstStore';

import {
  queryDefinition,
  printQueryFromDefinition,
} from './queryPrinting';

export class QueryManager {
  private networkInterface: NetworkInterface;
  private store: ReduxStore;
  private selectionSetMap: { [queryId: number]: SelectionSetWithRoot };

  private resultCallbacks: { [queryId: number]: QueryResultCallback[] };

  private idCounter = 0;

  constructor({
    networkInterface,
    store,
  }: {
    networkInterface: NetworkInterface,
    store: ReduxStore,
  }) {
    // XXX this might be the place to do introspection for inserting the `id` into the query? or
    // is that the network interface?
    this.networkInterface = networkInterface;
    this.store = store;

    this.selectionSetMap = {};
    this.resultCallbacks = {};

    this.store.subscribe(() => {
      this.broadcastNewStore(this.store.getState());
    });
  }

  public mutate({
    mutation,
    variables,
  }: {
    mutation: string,
    variables?: Object,
  }): Promise<any> {
    const mutationDef = parseMutation(mutation);

    const request = {
      query: mutation,
      variables,
    } as Request;

    return this.networkInterface.query(request)
      .then((result) => {
        const resultWithDataId = assign({
          __data_id: 'ROOT_MUTATION',
        }, result.data);

        this.store.dispatch(createQueryResultAction({
          result: resultWithDataId,
          selectionSet: mutationDef.selectionSet,
          variables,
        }));

        return result.data;
      });
  }

  public watchQuery({
    query,
    variables,
    forceFetch = true,
    returnPartialData = false,
  }: WatchQueryOptions): WatchedQueryHandle {
    // First, parse the query passed in -- this could also be done by a build plugin or tagged
    // template string
    const queryDef = parseQuery(query);

    // Set up a watch handle on the store using the parsed query, we need to do this first to
    // generate a query ID
    const watchHandle = this.watchSelectionSet({
      selectionSet: queryDef.selectionSet,
      rootId: 'ROOT_QUERY',
      typeName: 'Query',
      variables,
    });

    const queryId = watchHandle.id;

    let queryDefForRequest = queryDef;
    let existingData;
    let request = {
      query: query,
      variables,
    } as Request;

    if (!forceFetch) {
      // If the developer has specified they want to use the existing data in the store for this
      // query, use the query diff algorithm to get as much of a result as we can, and identify
      // what data is missing from the store
      const diffResult = this.diffRequestAgainstStore(request, queryDef.selectionSet);

      // Overwrite the request we were going to make with a smaller one
      queryDefForRequest = diffResult.minimalQueryDef;
      existingData = diffResult.existingData;
      request = diffResult.minimalRequest;
    }

    // Now, we have figured out what request we actually want to make to the server
    if (request) {
      // If we actually need to fetch anything over the network, do that
      this.makeRequest(queryId, request, queryDefForRequest.selectionSet);

      if (returnPartialData) {
        // Needs to be async to allow component to register result callback, even though we have
        // the data right away
        setTimeout(() => {
          throw new Error('partial result return not implemented');
        }, 0);
      }
    } else {
      // If we already had all of the data in the store to service the request, do it without
      // making any network requests at all
      setTimeout(() => {
        this.broadcastQueryChange(queryId, existingData);
      }, 0);
    }

    return watchHandle;
  }

  public broadcastNewStore(store: Store) {
    forOwn(this.selectionSetMap, (selectionSetWithRoot: SelectionSetWithRoot, queryId: string) => {
      const resultFromStore = readSelectionSetFromStore({
        store,
        rootId: selectionSetWithRoot.rootId,
        selectionSet: selectionSetWithRoot.selectionSet,
        variables: selectionSetWithRoot.variables,
      });

      this.broadcastQueryChange(queryId, resultFromStore);
    });
  }

  public watchSelectionSet(selectionSetWithRoot: SelectionSetWithRoot): WatchedQueryHandle {
    const queryId = this.idCounter.toString();
    this.idCounter++;

    this.selectionSetMap[queryId] = selectionSetWithRoot;

    const isStopped = () => {
      return !this.selectionSetMap[queryId];
    };

    return {
      id: queryId,
      isStopped,
      stop: () => {
        this.stopQuery(queryId);
      },
      onResult: (callback) => {
        if (isStopped()) { throw new Error('Query was stopped. Please create a new one.'); }

        this.registerResultCallback(queryId, callback);
      },
    };
  }

  private stopQuery(queryId) {
    delete this.selectionSetMap[queryId];
    delete this.registerResultCallback[queryId];
  }

  private broadcastQueryChange(queryId: string, result: any) {
    this.resultCallbacks[queryId].forEach((callback) => {
      callback(null, result);
    });
  }

  private handleQueryErrorsAndStop(queryId: string, errors: GraphQLError[]) {
    const errorCallbacks: QueryResultCallback[] = this.resultCallbacks[queryId];

    this.stopQuery(queryId);

    if (errorCallbacks && errorCallbacks.length) {
      errorCallbacks.forEach((callback) => {
        callback(errors);
      });
    } else {
      // XXX maybe provide some info here?
      throw new Error('Uncaught query errors. Use onError on the query handle to get errors.');
    }
  }

  private registerResultCallback(queryId: string, callback: QueryResultCallback): void {
    if (!this.resultCallbacks[queryId]) {
      this.resultCallbacks[queryId] = [];
    }

    this.resultCallbacks[queryId].push(callback);
  }

  private makeRequest(queryId: string, request: Request, selectionSet: SelectionSet) {
    this.networkInterface.query(request)
      .then((result: GraphQLResult) => {
        let errors: GraphQLError[] = result.errors;

        if (errors && errors.length) {
          this.handleQueryErrorsAndStop(queryId, errors);
        } else {
          // XXX handle multiple GraphQLResults
          // XXX handle partial responses where there was an error, right now we just bail out
          // completely if there are any execution errors
          const resultWithDataId = assign({
            __data_id: 'ROOT_QUERY',
          }, result.data);

          this.store.dispatch(createQueryResultAction({
            result: resultWithDataId,
            variables: request.variables,
            selectionSet,
          }));
        }
      }).catch((errors: GraphQLError[]) => {
        this.handleQueryErrorsAndStop(queryId, errors);
      });
  }

  private diffRequestAgainstStore(request: Request, selectionSet: SelectionSet) {
    let clonedRequest = assign({}, request) as Request;

    // Check if we already have the data to fulfill this query in the store
    const { missingSelectionSets, result } = diffSelectionSetAgainstStore({
      selectionSet,
      variables: request.variables,
      rootId: 'ROOT_QUERY',
      store: this.store.getState() as Store,
      throwOnMissingField: false,
    });

    let queryDefForRequest: OperationDefinition;
    if (missingSelectionSets.length) {
      // XXX if the server doesn't follow the relay node spec, we need
      // to refetch the whole query if there are any missing selection sets

      // Replace the original query with a new set of queries which we think will fetch the
      // missing data. The variables remain unchanged.
      queryDefForRequest = queryDefinition(missingSelectionSets);
      clonedRequest.query = printQueryFromDefinition(queryDefForRequest);
    } else {
      // We already have all of the data, no need to contact the server at all!
      clonedRequest = null;
    }

    return {
      existingData: result,
      minimalRequest: clonedRequest,
      minimalQueryDef: queryDefForRequest,
    };
  }
}

export interface SelectionSetWithRoot {
  rootId: string;
  typeName: string;
  selectionSet: SelectionSet;
  variables: Object;
}

export interface WatchedQueryHandle {
  id: string;
  isStopped: () => boolean;
  stop();
  onResult(callback: QueryResultCallback);
}

export type QueryResultCallback = (error: GraphQLError[], result?: any) => void;

export interface WatchQueryOptions {
  query: string;
  variables?: Object;
  forceFetch?: boolean;
  returnPartialData?: boolean;
}
