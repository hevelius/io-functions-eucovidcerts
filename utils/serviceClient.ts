import * as te from "fp-ts/lib/TaskEither";

import {
  IResponseErrorInternal,
  ResponseErrorInternal
} from "@pagopa/ts-commons/lib/responses";

import { getFetch } from "@pagopa/ts-commons/lib/agent";

import { LimitedProfile } from "@pagopa/io-functions-commons/dist/generated/definitions/LimitedProfile";

import { FiscalCode } from "@pagopa/ts-commons/lib/strings";

import { toError } from "fp-ts/lib/Either";

const fetch = getFetch(process.env);

export interface IServiceClient {
  readonly getLimitedProfileByPost: (
    reqHeaders: NodeJS.Dict<string | ReadonlyArray<string>>,
    fiscalCode: FiscalCode
  ) => te.TaskEither<IResponseErrorInternal, LimitedProfile>;
  readonly submitMessageForUser: (
    reqHeaders: NodeJS.Dict<string | ReadonlyArray<string>>,
    reqPayload: Response
  ) => te.TaskEither<IResponseErrorInternal, Response>;
}

export const createClient = (
  apiUrl: string,
  apiKey: string
): IServiceClient => ({
  getLimitedProfileByPost: (
    reqHeaders,
    fiscalCode
  ): ReturnType<IServiceClient["getLimitedProfileByPost"]> =>
    te
      .tryCatch(
        () =>
          fetch(`${apiUrl}/api/v1/profiles`, {
            body: JSON.stringify({ fiscal_code: fiscalCode }),
            headers: {
              ...reqHeaders,
              ["X-Functions-Key"]: apiKey
            },
            method: "POST"
          }),
        error => ResponseErrorInternal(String(error))
      )
      .chain(responseRaw =>
        te.tryCatch(
          () => responseRaw.json(),
          error => ResponseErrorInternal(String(error))
        )
      )
      .chain(response =>
        te.fromEither(
          LimitedProfile.decode(response).mapLeft(validationErrors =>
            ResponseErrorInternal(validationErrors.toString())
          )
        )
      ),
  submitMessageForUser: (
    reqHeaders,
    reqPayload
  ): ReturnType<IServiceClient["submitMessageForUser"]> =>
    te.tryCatch(
      () =>
        fetch(`${apiUrl}/api/v1/messages`, {
          body: JSON.stringify(reqPayload), // HAZARD
          headers: {
            ...reqHeaders,
            ["X-Functions-Key"]: apiKey
          },

          method: "POST"
        }),
      e => ResponseErrorInternal(toError(e).message)
    )
});
