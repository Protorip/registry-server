import { Code, ConnectError } from "@connectrpc/connect";
import {
  AbortedError,
  AlreadyExistsError,
  FailedPreconditionError,
  InvalidArgumentError,
  NotFoundError,
  PermissionDeniedError,
  UnauthenticatedError,
} from "../errors.js";

const codes = [
  [AbortedError, Code.Aborted],
  [AlreadyExistsError, Code.AlreadyExists],
  [FailedPreconditionError, Code.FailedPrecondition],
  [InvalidArgumentError, Code.InvalidArgument],
  [NotFoundError, Code.NotFound],
  [PermissionDeniedError, Code.PermissionDenied],
  [UnauthenticatedError, Code.Unauthenticated],
] as const;

export function mapError(error: unknown): ConnectError {
  for (const [ErrorType, code] of codes) {
    if (error instanceof ErrorType) return new ConnectError(error.message, code);
  }
  return ConnectError.from(error);
}
