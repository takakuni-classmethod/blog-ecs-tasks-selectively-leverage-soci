FROM public.ecr.aws/aws-observability/aws-for-fluent-bit:latest
COPY ./extra.conf /fluent-bit/etc/extra.conf

RUN ln -sf /usr/share/zoneinfo/Asia/Tokyo /etc/localtime