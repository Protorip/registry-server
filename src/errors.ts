export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends RegistryError {}
export class AlreadyExistsError extends RegistryError {}
export class InvalidArgumentError extends RegistryError {}
export class FailedPreconditionError extends RegistryError {}
export class AbortedError extends RegistryError {}
export class UnauthenticatedError extends RegistryError {}
export class PermissionDeniedError extends RegistryError {}
