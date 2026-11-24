use anyhow::Result;
use candle_core::Device;
use serde::Serialize;

use crate::models::MLX_SUPPORTED;
use crate::settings::DevicePref;

#[derive(Debug, Clone, Serialize)]
pub struct ComputeDevice {
    pub id        : String,
    pub label     : String,
    pub available : bool,
    pub note      : String,
}

pub fn list() -> Vec<ComputeDevice> {
    let mut devices = all();

    // MLX only exists on macOS, so other systems do not see the line at all.
    devices.retain(|d| d.id != "mlx" || cfg!(target_os = "macos"));

    devices
}

fn all() -> Vec<ComputeDevice> {
    let cuda  = candle_core::utils::cuda_is_available();
    let metal = candle_core::utils::metal_is_available();

    vec![
        ComputeDevice {
            id        : "cpu".into(),
            label     : "CPU".into(),
            available : true,
            note      : "Works on every platform".into(),
        },
        ComputeDevice {
            id        : "cuda".into(),
            label     : "NVIDIA GPU (CUDA)".into(),
            available : cuda,
            note      : if cuda {
                "CUDA device found".into()
            } else {
                "Not available in this build. Rebuild with the cuda feature and install the CUDA toolkit".into()
            },
        },
        ComputeDevice {
            id        : "mlx".into(),
            label     : "Apple GPU (MLX)".into(),
            available : MLX_SUPPORTED,
            note      : if MLX_SUPPORTED {
                "MLX models run on the Apple GPU. Install MLX in Storage".into()
            } else {
                "Needs a Mac with Apple silicon".into()
            },
        },
        ComputeDevice {
            id        : "metal".into(),
            label     : "Apple GPU (Metal)".into(),
            available : metal,
            note      : if metal {
                "Metal device found".into()
            } else {
                "Only available on macOS".into()
            },
        },
    ]
}

/// Picks the compute device. `Auto` prefers CUDA, then Metal, then CPU, and
/// falls back to CPU when a GPU backend fails to initialise.
pub fn select(pref: DevicePref) -> Result<(Device, String)> {
    match pref {
        DevicePref::Cpu   => Ok((Device::Cpu, "cpu".into())),
        DevicePref::Cuda  => Ok((Device::new_cuda(0)?, "cuda".into())),
        DevicePref::Metal => Ok((Device::new_metal(0)?, "metal".into())),
        DevicePref::Auto  => {
            if candle_core::utils::cuda_is_available() {
                match Device::new_cuda(0) {
                    Ok(device) => return Ok((device, "cuda".into())),
                    Err(err)   => log::warn!("CUDA init failed, falling back: {err}"),
                }
            }

            if candle_core::utils::metal_is_available() {
                match Device::new_metal(0) {
                    Ok(device) => return Ok((device, "metal".into())),
                    Err(err)   => log::warn!("Metal init failed, falling back: {err}"),
                }
            }

            Ok((Device::Cpu, "cpu".into()))
        }
    }
}
