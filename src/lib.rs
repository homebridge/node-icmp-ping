mod engine;
mod identifier;
mod packet;
use napi::{bindgen_prelude::AsyncTask, Env, Error, Result, Status, Task};
use napi_derive::napi;
use std::net::IpAddr;

#[napi(object)]
pub struct PingResult {
    pub success: bool,
    // Explicit null rather than an optional/omitted property.
    pub latency: napi::bindgen_prelude::Either<f64, napi::bindgen_prelude::Null>,
    pub message: String,
}

pub struct PingTask {
    address: String,
}
impl Task for PingTask {
    type Output = engine::Outcome;
    type JsValue = PingResult;
    fn compute(&mut self) -> Result<Self::Output> {
        let target: IpAddr = self.address.parse().map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "Expected an IPv4 or IPv6 literal; hostnames and scoped addresses are not accepted",
            )
        })?;
        let options = engine::Options::default();
        options
            .validate()
            .map_err(|e| Error::new(Status::GenericFailure, e))?;
        let lease =
            identifier::Lease::acquire().map_err(|e| Error::new(Status::GenericFailure, e))?;
        let mut payload = vec![0u8; options.payload_size];
        getrandom::fill(&mut payload)
            .map_err(|e| Error::new(Status::GenericFailure, format!("ICMP random payload: {e}")))?;
        let (mut socket, local) = engine::Raw::open(target, &options)
            .map_err(|e| Error::new(Status::GenericFailure, e))?;
        engine::probe(&mut socket, target, local, lease.0, &payload, &options)
            .map_err(|e| Error::new(Status::GenericFailure, e))
        // socket and identifier lease drop before compute returns to Node-API.
    }
    fn resolve(&mut self, _: Env, out: Self::Output) -> Result<Self::JsValue> {
        Ok(PingResult {
            success: out.latency.is_some(),
            latency: match out.latency {
                Some(v) => napi::bindgen_prelude::Either::A(v),
                None => napi::bindgen_prelude::Either::B(napi::bindgen_prelude::Null),
            },
            message: out.message,
        })
    }
}
#[napi(ts_return_type = "Promise<PingResult>")]
pub fn ping(ip: String) -> AsyncTask<PingTask> {
    AsyncTask::new(PingTask { address: ip })
}
