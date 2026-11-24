use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    /// Stable selection key: "<host>::<device name>".
    pub key            : String,
    pub name           : String,
    pub host           : String,
    pub input          : bool,
    pub output         : bool,
    pub default_input  : bool,
    pub default_output : bool,
}

pub fn list_devices() -> Vec<AudioDeviceInfo> {
    let mut out = Vec::new();

    for host_id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(host_id) else { continue };

        let host_name   = host_id.name().to_string();
        let default_in  = host.default_input_device().map(|d| d.to_string());
        let default_out = host.default_output_device().map(|d| d.to_string());

        let Ok(devices) = host.devices() else { continue };

        for device in devices {
            let name = device.to_string();

            out.push(AudioDeviceInfo {
                key            : format!("{host_name}::{name}"),
                host           : host_name.clone(),
                input          : device.supports_input(),
                output         : device.supports_output(),
                default_input  : default_in.as_deref() == Some(name.as_str()),
                default_output : default_out.as_deref() == Some(name.as_str()),
                name,
            });
        }
    }

    out
}

pub fn find_device(key: &str) -> Option<cpal::Device> {
    let (host_name, device_name) = key.split_once("::")?;

    for host_id in cpal::available_hosts() {
        if host_id.name() != host_name {
            continue;
        }

        let host = cpal::host_from_id(host_id).ok()?;

        for device in host.devices().ok()? {
            if device.to_string() == device_name {
                return Some(device);
            }
        }
    }

    None
}
