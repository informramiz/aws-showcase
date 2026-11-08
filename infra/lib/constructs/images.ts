import { Duration, type RemovalPolicy } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  EventType,
  HttpMethods,
  ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Construct } from "constructs";
import { IMAGE_KEY_PREFIX, UPLOAD_URL_TTL_SECONDS } from "../../../src/features/events/domain/event-image.js";

export interface ImagesProps {
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Private bucket for event images. Clients upload with presigned PUT URLs; nothing is publicly readable
 * (serve through CloudFront with Origin Access Control when a public read path is needed).
 */
export class Images extends Construct {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: ImagesProps) {
    super(scope, id);

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: false,
      lifecycleRules: [
        // Failed multipart uploads leave invisible parts that are still billed.
        { id: "abort-incomplete-uploads", abortIncompleteMultipartUploadAfter: Duration.days(1) },
        // Events are long over after a year; their images are not worth paying for after that.
        { id: "expire-old-images", prefix: IMAGE_KEY_PREFIX, expiration: Duration.days(400) },
      ],
      // Browsers PUT straight to S3 with the presigned URL. The signature is the authorization; a
      // production stack would pin allowedOrigins to its web app's origin.
      cors: [
        {
          allowedMethods: [HttpMethods.PUT],
          allowedOrigins: ["*"],
          allowedHeaders: ["content-type", "content-length"],
          maxAge: UPLOAD_URL_TTL_SECONDS,
        },
      ],
    });
  }

  /** Lets a function sign upload URLs: a presigned URL carries the signer's permissions. */
  grantUpload(fn: IFunction): void {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [this.bucket.arnForObjects(`${IMAGE_KEY_PREFIX}*`)],
      }),
    );
  }

  /** Validation needs to read the first bytes and delete what it rejects; nothing else. */
  onImageUploaded(fn: IFunction): void {
    fn.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: [this.bucket.arnForObjects(`${IMAGE_KEY_PREFIX}*`)],
      }),
    );
    this.bucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(fn), {
      prefix: IMAGE_KEY_PREFIX,
    });
  }
}
