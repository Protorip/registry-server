declare module "s3rver" {
  export default class S3rver {
    constructor(options: {
      address: string;
      port: number;
      silent: boolean;
      directory: string;
      configureBuckets: Array<{ name: string }>;
    });
    middleware: Array<
      (
        context: { method: string; query: Record<string, unknown> },
        next: () => Promise<void>,
      ) => Promise<void>
    >;
    store: {
      listObjects(
        bucket: string,
        options: Record<string, never>,
      ): Promise<{ objects: Array<{ key: string }> }>;
      deleteObject(bucket: string, key: string): Promise<void>;
    };
    run(): Promise<{ port: number }>;
    close(): Promise<void>;
  }
}
