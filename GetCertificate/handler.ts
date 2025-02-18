import * as express from "express";

import {
  withRequestMiddlewares,
  wrapRequestHandler
} from "@pagopa/io-functions-commons/dist/src/utils/request_middleware";
import {
  IResponseErrorForbiddenNotAuthorized,
  IResponseErrorInternal,
  IResponseErrorValidation,
  IResponseSuccessJson,
  ResponseErrorInternal,
  ResponseSuccessJson
} from "@pagopa/ts-commons/lib/responses";
import { RequiredBodyPayloadMiddleware } from "@pagopa/io-functions-commons/dist/src/utils/middlewares/required_body_payload";
import { ContextMiddleware } from "@pagopa/io-functions-commons/dist/src/utils/middlewares/context_middleware";
import {
  fromEither,
  fromLeft,
  taskEither,
  tryCatch
} from "fp-ts/lib/TaskEither";
import { readableReport } from "@pagopa/ts-commons/lib/reporters";
import { ResponseErrorValidation } from "@pagopa/ts-commons/lib/responses";
import { identity, toString } from "fp-ts/lib/function";
import { PreferredLanguageEnum } from "@pagopa/io-functions-commons/dist/generated/definitions/PreferredLanguage";
import { Context } from "@azure/functions";
import { TypeofApiCall } from "@pagopa/ts-commons/lib/requests";
import { Either, toError } from "fp-ts/lib/Either";
import { Validation } from "io-ts";
import { StatusEnum } from "../generated/definitions/ValidCertificate";
import { Certificate } from "../generated/definitions/Certificate";
import { GetCertificateParams } from "../generated/definitions/GetCertificateParams";
import { Mime_typeEnum } from "../generated/definitions/QRCode";
import { GetCertificateByAutAndCFT } from "../generated/dgc/requestTypes";
import { SearchSingleQrCodeResponseDTO } from "../generated/dgc/SearchSingleQrCodeResponseDTO";
import { toSHA256 } from "../utils/conversions";
import { createDGCClientSelector } from "../utils/dgcClientSelector";
import { parseQRCode, printers } from "./certificate";

const assertNever = (x: never): never => {
  throw new Error(`Unexpected object: ${toString(x)}`);
};

type DGCGetCertificateResponses = ReturnType<
  TypeofApiCall<GetCertificateByAutAndCFT>
> extends Promise<Validation<infer Y>>
  ? Y
  : never;

type Failures =
  | IResponseErrorInternal
  | IResponseErrorValidation
  | IResponseErrorForbiddenNotAuthorized;
type GetCertificateHandler = (
  context: Context,
  params: GetCertificateParams
) => Promise<IResponseSuccessJson<Certificate> | Failures>;
export const GetCertificateHandler = (
  dgcClientSelector: ReturnType<typeof createDGCClientSelector>
): GetCertificateHandler => async (
  _context,
  { fiscal_code, auth_code: authCodeSHA256 }
): Promise<IResponseSuccessJson<Certificate> | Failures> => {
  // prints a certificate into huma nreadable text - italian only for now
  const printer = printers[PreferredLanguageEnum.it_IT];
  const hashedFiscalCode = toSHA256(fiscal_code);

  return (
    taskEither
      .of<Failures, string>(hashedFiscalCode)
      .map(hasedFc => dgcClientSelector.select(hasedFc))
      // wraps http request and handles generic exceptions
      .chain(dgcClient =>
        tryCatch<
          Failures,
          Either<IResponseErrorInternal, DGCGetCertificateResponses>
        >(
          () =>
            dgcClient
              .getCertificateByAutAndCF({
                body: {
                  authCodeSHA256,
                  cfSHA256: hashedFiscalCode
                }
              })
              // this happens when the response payload cannot be parsed
              .then(_ =>
                _.mapLeft(e => ResponseErrorInternal(readableReport(e)))
              ),
          // this is an unhandled error during connection - it might be timeout
          _ => ResponseErrorInternal(toError(_).message)
        ).chain(fromEither)
      )
      // separates bad cases from success, and assign each failure its correct response
      .chain<SearchSingleQrCodeResponseDTO>(e => {
        switch (e.status) {
          case 200:
            return taskEither.of(e.value);
          case 400:
            return fromLeft(ResponseErrorValidation("Bad Request", ""));
          case 500:
            return fromLeft(ResponseErrorInternal(toString(e.value)));
          default:
            return assertNever(e);
        }
      })
      // try to enhance raw certificate with parsed data
      .map(({ data: { qrcodeB64 = "", uvci } = {} }) => ({
        printedCertificate: parseQRCode(qrcodeB64).fold(
          _ => undefined,
          f => ({
            detail: printer.detail(f),
            info: printer.info(f),
            uvci: f.id
          })
        ),
        qrcodeB64,
        uvci
      }))
      // compose a response payload
      .map<Certificate>(e => ({
        detail: e.printedCertificate?.detail,
        // if we successful pardsed the qr code, we retrieve the identifier from the parsing
        //   otherwise we retrieve the identifier eventually received from DGC
        info: e.printedCertificate?.info,
        qr_code: {
          content: e.qrcodeB64,
          mime_type: Mime_typeEnum["image/png"]
        },
        status: StatusEnum.valid,
        uvci: e.printedCertificate?.uvci || e.uvci
      }))
      .map(ResponseSuccessJson)
      // fold failures and success cases into a single response pipeline
      .fold<IResponseSuccessJson<Certificate> | Failures>(identity, identity)
      .run()
  );
};

export const getGetCertificateHandler = (
  dgcClientSelector: ReturnType<typeof createDGCClientSelector>
): express.RequestHandler => {
  const handler = GetCertificateHandler(dgcClientSelector);

  return wrapRequestHandler(
    withRequestMiddlewares(
      ContextMiddleware(),
      RequiredBodyPayloadMiddleware(GetCertificateParams)
    )(handler)
  );
};
